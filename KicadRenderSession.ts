// Framework-agnostic render session — the reusable core extracted out of
// demo/main.ts so both the standalone demo AND the Angular viewer drive the
// exact same camera/scene/render-loop logic instead of maintaining two
// copies that could drift. Deliberately does NOT touch `document` or attach
// any DOM event listeners itself (that was main.ts's original sin — it ran
// canvas/DOM lookups at MODULE SCOPE, which is unsafe to import directly
// into a component/service file). The caller owns the canvas elements, the
// event wiring (pointer/wheel/click), and any UI (layer checklist, status
// text) — this class owns camera state, scene building, and painting.

import { onBoardBarcodeEncoderReady } from './paint/BarcodeEncoder';
import * as SessionState from './state';
import { KicadParser }                from '@kicad-io/KicadParser';
import {
	KicadElementWire
}                                     from '@kicad-io/KicadElementWire';
import {
	KicadElementBus, KicadElementBusEntry
}                                     from '@kicad-io/KicadElementBus';
import {
	KicadElementJunction
}                                     from '@kicad-io/KicadElementJunction';
import {
	KicadElementNoConnect
}                                     from '@kicad-io/KicadElementNoConnect';
import {
	KicadElementRectangle, KicadElementGrLine, KicadElementGrRect, KicadElementFpLine, KicadElementFpRect
}                                     from '@kicad-io/KicadElementStartEnd';
import {
	KicadElementCircle, KicadElementGrCircle, KicadElementFpCircle
}                                     from '@kicad-io/KicadElementCircle';
import {
	KicadElementArc, KicadElementGrArc, KicadElementFpArc
}                                     from '@kicad-io/KicadElementArc';
import {
	KicadElementPolyline, KicadElementBezier, KicadElementGrCurve
}                                     from '@kicad-io/KicadElementPolyline';
import {
	KicadElementGrPoly, KicadElementPolygon, type GrShapeFillMode
}                                     from '@kicad-io/KicadElementPolygon';
import {
	type KicadStrokeType
}                                     from '@kicad-io/KicadElementStroke';
import {
	KicadElementAt
}                                     from '@kicad-io/KicadElementAt';
import {
	KicadElement
}                                     from '@kicad-io/KicadElement';
import {
	KicadElementSize
}                                     from '@kicad-io/KicadElementSize';
import {
	KicadElementTable, KicadElementTableCell
}                                     from '@kicad-io/KicadElementTable';
import {
	KicadElementRuleArea
}                                     from '@kicad-io/KicadElementRuleArea';
import {
	KicadElementGroup
}                                     from '@kicad-io/KicadElementGroup';
import {
	KicadElementData
}                                     from '@kicad-io/KicadElementData';
import {
	KicadElementImage
}                                     from '@kicad-io/KicadElementImage';
import {
	KicadElementBarcode
}                                     from '@kicad-io/KicadElementBarcode';
import {
	KicadElementText, KicadElementTextBox, KicadElementLabel, KicadElementGrText, KicadElementGrTextBox
}                                     from '@kicad-io/KicadElementText';
import {
	KicadElementGlobalLabel, type KicadGlobalLabelShape
}                                     from '@kicad-io/KicadElementGlobalLabel';
import {
	KicadElementHierarchicalLabel, type KicadHierarchicalLabelShape
}                                     from '@kicad-io/KicadElementHierarchicalLabel';
import {
	KicadElementNetclassFlag, type KicadDirectiveLabelShape
}                                     from '@kicad-io/KicadElementNetclassFlag';
import {
	KicadElementSymbol
}                                     from '@kicad-io/KicadElementSymbol';
import {
	KicadElementProperty
}                                     from '@kicad-io/KicadElementProperty';
import {
	KicadElementFootprint
}                                     from '@kicad-io/KicadElementFootprint';
import {
	KicadElementPad
}                                     from '@kicad-io/KicadElementPad';
import {
	KicadElementNet
}                                     from '@kicad-io/KicadElementNet';
import {
	KicadElementSegment
}                                     from '@kicad-io/KicadElementStartEnd';
import {
	KicadElementVia
}                                     from '@kicad-io/KicadElementVia';
import {
	KicadElementZone,
	type ZoneHatchStyle, type ZonePadConnectionType, type ZoneSmoothingType, type ZoneIslandRemovalMode,
	type RuleAreaKeepoutSettings
}                                     from '@kicad-io/KicadElementZone';
import {
	KicadElementDimension
}                                     from '@kicad-io/KicadElementDimension';
import {
	KicadElementSheet
}                                     from '@kicad-io/KicadElementSheet';
import {
	KicadElementPin
}                                     from '@kicad-io/KicadElementPin';
import {
	KicadElementLibSymbols
}                                     from '@kicad-io/KicadElementLibSymbols';
import {
	KicadElementLibId
}                                     from '@kicad-io/KicadElementString';
import {
	SchematicConnectivityService, type SchematicConnectivitySummary
}                                     from '@kicad-layout/Connectivity';
import {
	KicadElementUnit
}                                     from '@kicad-io/KicadElementNumeric';
import {
	KicadElementDnp
}                                     from '@kicad-io/KicadElementBoolean';
import {
	buildPowerFlag, buildPowerGnd, buildPowerRail
}                                     from '@kicad-io/Builder/PassiveSymbolBuilder';
import {
	buildPowerSymbolInstance
}                                     from '@kicad-io/Builder/PowerSymbolInstance';

export type { KicadGlobalLabelShape }                 from '@kicad-io/KicadElementGlobalLabel';
export type { KicadDirectiveLabelShape }              from '@kicad-io/KicadElementNetclassFlag';
/** Pcbnew's 3 crosshair styles (CROSS_HAIR_MODE in KiCad's own
 *  gal_display_options.h) — 'small' relies on the browser's own cursor and
 *  draws nothing extra; 'full'/'diagonal' are drawn by drawBoardCrosshair. */
export type CrosshairMode = 'small' | 'full' | 'diagonal';
import { Vec2 }                                       from './math/Vec2';
import { Angle }                                      from './math/Angle';
import { Matrix3 }                                    from './math/Matrix3';
import { Camera2 }                                    from './math/Camera2';
import { Renderer }                                   from './render/Renderer';
import { Canvas2dRenderer }                           from './render/Canvas2dRenderer';
import { WebGLRenderer }                              from './render/WebGLRenderer';
import {
	BoardPainter, boardPaintOrder, defaultLayerState, paintHighlightOverlay,
	LayeredBoardScene, LayerVisibilityState, PaintedItem, ZoneDisplayMode, ItemDisplayMode
}                                                     from './paint/BoardPainter';
import {
	SchematicPainter, defaultSchLayerState,
	SchematicScene, SchLayerVisibilityState, SchematicSheetRef, SchematicDocInfo, SchPaintedItem
}                                                     from './paint/SchematicPainter';
import { boardBackgroundColor, styleForLayer }        from './paint/LayerColors';
import { layerPaintRank }                             from './paint/LayerOrder';
import { buildBoardRatsnest, type BoardRatsnestLine } from './paint/BoardRatsnest';
import { buildCopperGraph, buildTrackChainGraph, type CopperGraph }         from './paint/BoardCopperGraph';
import { buildInitialTrace }                          from './router/PnsDragger';
import {
	buildBoardOutlineRegionNm, buildEdgeExclusionsByLayer, buildZoneFillJobs, KeepoutZoneInput, MmPath,
	OtherZoneInput, resolveCopperLayers, ZoneFillJob
}                                                     from './paint/BoardZoneFill';

/** Off-main-thread runner for zone-fill jobs, injected by the app (a Web
 *  Worker wrapper — see apps/kicad-viewer/src/worker/zoneFillClient.ts) so
 *  this shared package stays decoupled from the app's own worker/bundler
 *  setup, same reasoning as registerKicadIoClasses for @kicad-io. */
export type ZoneFillExecutor = (
	jobs: ZoneFillJob[],
	onProgress?: (done: number, total: number) => void
) => Promise<{ zoneUuid: string; layer: string; points: MmPath }[]>;

import { schematicBackgroundColor, schematicGridColor }      from './paint/SchematicColors';
import { hitTest, hitTestAll }                               from './paint/HitTest';
import { distanceToSegment }                                 from './paint/PaintedShape';
import { computeStrokeTextGeometry, drawStrokeTextGeometry } from './paint/TextPaint';
import { registerDefaultKicadClasses }                       from './RegisterDefaultClasses';
import {
	sexprParenDelta, repairLegacyMalformedZoneText, resolveZoneClearanceMm, computeWireBend, readBoardOrigin,
	JUNCTION_POINT_EPS, SYNTHETIC_ANGLE_BASE, pointsNear, arcCircumcenter,
	quantizedAngle, pointLiesOnSegmentInterior, cubicBezierToPolyline
} from './utils';
import { parseText, parseBoardText } from './parser';
import { rebuildActiveScene, scheduleFootprintRebuild, rebuildAfterFootprintGeometryEdit, rebuildSchScene, rebuildBoardSceneIfPending } from './pipeline';
import * as Layers from './layers';

import type {
	RenderBackend, RenderDocumentType, LoadResult, ZoneDraft, RuleAreaDraft,
	PolygonDraft, HitResult, ResizeHandle, AlignAxis, SelectionResizeBox,
	CurveAnchor, SelectionCurveAnchors, SchLineMode, ZoneFillDesignSettings,
	EditPreviewState, ViaDragFix, SymbolPoseInfo
} from './types';
// Re-exported so `@kicad-render/KicadRenderSession` (this module's own deep-
// import path, used throughout apps/kicad-viewer) still resolves these —
// they moved to types.ts, but every existing external `import type {...}
// from '@kicad-render/KicadRenderSession'` call site was written against
// this file as their source, not the new module.
export type {
	RenderBackend, RenderDocumentType, LoadResult, ZoneDraft, RuleAreaDraft,
	PolygonDraft, HitResult, ResizeHandle, AlignAxis, SelectionResizeBox,
	CurveAnchor, SelectionCurveAnchors, SchLineMode, ZoneFillDesignSettings,
	EditPreviewState, ViaDragFix, SymbolPoseInfo
} from './types';

export interface BoardDragPerformance {
	startedAt: number;
	frames: number;
	fastFrames: number;
	fallbackFrames: number;
	staticRebuilds: number;
	ratsnestMs: number;
	fallbackReasons: Record<string, number>;
	endedAt?: number;
	durationMs?: number;
}






/** Real KiCad's `LINE_MODE` (`eeschema_settings.h`): `free` draws a single
 *  segment at any angle; `90` (the default) and `45` auto-insert a bend so
 *  the drawn path is always two constrained segments instead of one
 *  arbitrary-angle one. */

/**
 * Computes the bend point (if any) for a wire/bus segment being drawn from
 * `from` to `to` under the given line mode:
 * - `free`: never bends — a single segment at any angle.
 * - `90` (real KiCad's default): the bend follows whichever axis the
 *   cursor has moved further along from `from` (the same "dominant axis"
 *   heuristic real KiCad's own line tool uses while dragging, so the
 *   preview always matches where the click will actually land).
 * - `45`: one leg orthogonal, the other a true 45-degree diagonal covering
 *   the shorter of the two axis deltas — a simplified, non-posture-tracking
 *   read of real KiCad's `computeBreakPoint()` (`sch_line_wire_bus_tool.cpp`),
 *   which additionally remembers the previous segment's direction across a
 *   whole multi-segment drag to pick between two valid 45-degree "postures";
 *   this app's wire tool only ever draws one segment per click pair, so
 *   there's no prior-segment state to consult and a single well-defined
 *   choice (dominant axis gets the orthogonal leg) suffices.
 * Returns null whenever no bend is needed — `from`/`to` already satisfy the
 * mode's constraint with a single straight segment (already axis-aligned
 * for `90`, already exactly diagonal for `45`, or unconditionally for `free`).
 */
export { computeWireBend } from './utils';

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

	/** See SchematicPainter.symbolEditMode's own doc comment — call once
	 *  (true) on a Symbol Editor's own private session, never on the shared
	 *  schematic/PCB session. */
	setSymbolEditMode(enabled: boolean): void {
		this.schematicPainter.symbolEditMode = enabled;
	}

	/** Real KiCad's eeschema "Show Hidden Pins" toolbar toggle
	 *  (`SCH_RENDER_SETTINGS::m_ShowHiddenPins`) — force-renders pins marked
	 *  `hide` in their library definition. Rebuilds the scene since
	 *  visibility is baked into which vertices got uploaded. */
	get hiddenPinsVisible(): boolean { return this.schematicPainter.showHiddenPins; }

	setHiddenPinsVisible(visible: boolean): void {
		if (this.schematicPainter.showHiddenPins === visible) {
			return;
		}
		this.schematicPainter.showHiddenPins = visible;
		this.geometryDirty = true;
		this.scheduleRender();
	}

	/** Real KiCad's eeschema "Line Mode" toolbar toggle (`LINE_MODE`,
	 *  `eeschema_settings.h`) — see `computeWireBend`'s own doc comment for
	 *  what each mode does. Only affects the live wire/bus-drawing preview
	 *  here (`drawEditPreview`'s 'wire' case); the actual committed bend
	 *  point is computed the same way by the caller (`PointerController`)
	 *  before calling `addWire`/`addBus`, so both stay in sync as long as
	 *  callers read the same mode for both. Doesn't affect baked scene
	 *  geometry, so no `geometryDirty` — just redraws the overlay. */
	protected lineMode: SchLineMode = '90';

	get currentLineMode(): SchLineMode { return this.lineMode; }

	setLineMode(mode: SchLineMode): void {
		if (this.lineMode === mode) {
			return;
		}
		this.lineMode = mode;
		this.scheduleRender();
	}

	/** Real KiCad's eeschema "Annotate Automatically" toolbar toggle
	 *  (`EESCHEMA_SETTINGS::m_AnnotatePanel.automatic`) — see
	 *  `addLibrarySymbolFromText`'s use of this flag and `annotateSchematic`'s
	 *  own doc comment for what happens on each side of it. Defaults `true`
	 *  to match this app's own long-standing placement behavior (every
	 *  placed symbol has always immediately gotten a real reference) —
	 *  introducing the flag is a no-op until the toggle button is used. */
	protected annotateAutomatically = true;

	get isAnnotateAutomatically(): boolean { return this.annotateAutomatically; }

	setAnnotateAutomatically(enabled: boolean): void {
		this.annotateAutomatically = enabled;
	}

	/**
	 * Real KiCad's "Annotate Schematic" command (Tools > Annotate Schematic),
	 * scoped to the CURRENT SHEET only (this session only ever holds one
	 * sheet's AST at a time — see the project-wide-AST-staleness lesson
	 * elsewhere in this codebase) and to a single fixed strategy: real
	 * KiCad's own dialog additionally offers sort-by-X/-Y-position and
	 * sheet-number-multiplier options, none of which are ported here.
	 *
	 * Assigns every symbol instance whose Reference is still an
	 * un-annotated placeholder (the `"<prefix>?"` shape
	 * `addLibrarySymbolFromText` writes when Annotate Automatically is off)
	 * the next free number for its prefix, walked in schematic document
	 * order. Multi-unit placements are grouped WITHOUT any shared identity
	 * field (this app's own model has none — see `findSymbolInstanceById`'s
	 * doc comment: distinct units of one physical part are wholly separate
	 * AST elements, linked only by sharing a Reference string once
	 * annotated) via the same bin-packing rule real KiCad's own
	 * `REFDES_TRACKER::GetNextRefDesForUnits` uses
	 * (`eeschema/refdes_tracker.cpp`): the lowest number N is reused across
	 * several placeholders sharing one (libId, Value) pair as long as no
	 * two of them claim the same unit ordinal at that N — since one
	 * physical multi-unit placement's units always have DISTINCT unit
	 * numbers (1, 2, 3…) while two SEPARATE placements of the same part
	 * both start at unit 1, this reconstructs "which placeholders are one
	 * physical component" without ever needing an explicit identity link.
	 * Already-annotated (non-"?") symbols seed the same used-number map so
	 * a freshly assigned number can never collide with one already on the
	 * sheet. Returns the count of symbols annotated.
	 */
	annotateSchematic(): number {
		if (!this.schematicRoot?.rootElement) {
			return 0;
		}
		const symbols: KicadElementSymbol[] = this.schematicRoot.rootElement.findChildrenByClass(KicadElementSymbol);
		type Slot = { libId: string; value: string; units: Set<number> };
		const usedByPrefix = new Map<string, Map<number, Slot>>();
		const keyOf = (symbol: KicadElementSymbol) => ({
			libId: symbol.getLibId() ?? '',
			value: String(symbol.getAllProperties().Value ?? ''),
			unit: symbol.getUnitId() || 1
		});
		const claim = (prefix: string, num: number, libId: string, value: string, unit: number) => {
			let byNum = usedByPrefix.get(prefix);
			if (!byNum) {
				byNum = new Map();
				usedByPrefix.set(prefix, byNum);
			}
			let slot = byNum.get(num);
			if (!slot) {
				slot = { libId, value, units: new Set() };
				byNum.set(num, slot);
			}
			slot.units.add(unit);
		};
		for (const symbol of symbols) {
			const ref = symbol.getReference();
			if (!ref || ref.endsWith('?')) {
				continue;
			}
			const match = /^(.*?)(\d+)$/.exec(ref);
			if (!match) {
				continue;
			}
			const { libId, value, unit } = keyOf(symbol);
			claim(match[1]!, Number(match[2]), libId, value, unit);
		}
		let annotated = 0;
		const toAnnotate = symbols.filter(symbol => symbol.getReference()?.endsWith('?'));
		if (!toAnnotate.length) {
			return 0;
		}
		this.pushUndoSnapshot('Annotate Schematic');
		for (const symbol of toAnnotate) {
			const ref = symbol.getReference()!;
			const prefix = ref.slice(0, -1);
			const { libId, value, unit } = keyOf(symbol);
			const byNum = usedByPrefix.get(prefix);
			let num = 1;
			while (true) {
				const slot = byNum?.get(num);
				if (!slot || (slot.libId === libId && slot.value === value && !slot.units.has(unit))) {
					break;
				}
				num++;
			}
			claim(prefix, num, libId, value, unit);
			symbol.setProperty('Reference', `${ prefix }${ num }`);
			annotated++;
		}
		this.commitAstMutation();
		return annotated;
	}

	protected readonly canvas2d: HTMLCanvasElement;
	protected readonly canvasGl: HTMLCanvasElement | null;
	protected readonly canvas2dRenderer: Canvas2dRenderer;
	protected readonly webglRenderer: WebGLRenderer | null;

	protected backend: RenderBackend;
	protected documentType: RenderDocumentType = 'board';
	protected scene: LayeredBoardScene | null = null;
	/** PCB editor's active layer. It is drawn above the ordinary board stack. */
	protected activeBoardLayer: string | null = null;
	protected layerState: Map<string, LayerVisibilityState> = new Map();
	protected schScene: SchematicScene | null = null;
	protected schLayerState: Map<string, SchLayerVisibilityState> = new Map();
	/** Retained across loadSchematicText so moveSymbolByRef can mutate + rebuild the scene without re-parsing text. */
	protected schematicRoot: { rootElement: any } | null = null;
	protected schematicDocInfo: SchematicDocInfo | undefined = undefined;
	/** Board-side counterpart of schematicRoot — retained across loadBoardText
	 *  so board mutation methods (moveFootprintByPaintId, ...) can mutate +
	 *  rebuild the scene without re-parsing text. */
	protected boardRoot: { rootElement: any } | null = null;
	/** Last canonical board text, retained so undo can snapshot the document
	 * before a mutation without serializing a large board a second time. */
	protected boardTextSnapshot = '';
	/** Multi-select-capable — see select()/selectMultiple()/selection/selectionIds. */
	protected selectedIds: Set<string> = new Set();
	/** Hover-driven net highlight IDs — painted in the same highlight color as selection. */
	protected highlightedNetIds: Set<string> = new Set();
	protected highlightedNetName: string | null = null;
	/** Board's own net-highlight state — a numeric netId (boards have no
	 *  paint-id-set equivalent; matching is done live, per-item, by
	 *  BoardPainter.paint() — see highlightBoardNetAtScreen). */
	protected highlightedBoardNetId: number | null = null;
	protected highlightedBoardNetName: string | null = null;
	protected connectivityService = new SchematicConnectivityService();
	protected connectivityCacheText: string | null = null;
	protected connectivityCache: SchematicConnectivitySummary | null = null;
	/** Overrides drawGrid()'s default spacing — see setGridSpacing(). null
	 *  means "use the built-in default" (1.27mm schematic / 0.5mm board). */
	protected gridSpacingMm: number | null = null;
	protected gridVisible = true;
	/** Pcbnew's independently persisted grid and drill/place-file origins. */
	protected boardGridOrigin = new Vec2(0, 0);
	protected boardDrillPlaceOrigin = new Vec2(0, 0);
	/** Hand-drawn editor's in-progress tool state — see drawEditPreview(). */
	protected editPreview: EditPreviewState | null = null;
	/** Board-side "outline this footprint" cue — see setFootprintHighlight()/
	 *  drawBoardHighlight(). Boards have no click-select/highlight machinery
	 *  otherwise (see the harmonic-munching-trinket plan's Phase 7); this is
	 *  deliberately the minimum needed to make a cross-tab schematic
	 *  selection visible on a board, not a step toward full PCB interaction. */
	protected boardHighlight: { bbox: { x: number; y: number; w: number; h: number } } | null = null;
	protected ratsnestLines: BoardRatsnestLine[] = [];
	protected ratsnestVisible = true;
	/** Position signature of the last fast-drag commit's moved footprints (see
	 *  commitBoardDragFast's Fix-3 skip), so an unchanged-position re-commit
	 *  doesn't re-run the net-scoped copper-graph build. Invalidated whenever
	 *  the whole scene is rebuilt (i.e. on any structural edit or a manual
	 *  refreshBoardRatsnest), so it can never cause a stale skip. */
	protected lastRatsnestCommitSignature: string | null = null;
	protected zoneDisplayMode: ZoneDisplayMode = 'filled';
	protected padDisplayMode: ItemDisplayMode = 'filled';
	protected viaDisplayMode: ItemDisplayMode = 'filled';
	protected trackDisplayMode: ItemDisplayMode = 'filled';
	/** Pcbnew's left-toolbar crosshair style — see drawBoardCrosshair(). All
	 *  three actually draw something (real KiCad replaces the OS cursor with
	 *  its own GAL-drawn crosshair for all of them — 'small' just uses a
	 *  short fixed-length cross instead of a full-window one). */
	protected crosshairMode: CrosshairMode = 'small';
	/** Last known pointer position in screen (CSS pixel) space, updated by the
	 *  board pointer controller on every mousemove regardless of gesture state
	 *  — the fallback drawBoardCrosshair() position when no snapped working
	 *  point is available (e.g. no tool active). */
	protected boardPointerScreen: Vec2 | null = null;
	/** The board editor's current WORKING point in world space — where the
	 *  next click actually lands, which is not always the same as the raw
	 *  mouse position: grid-snapped in general, and magnetized onto a pad/
	 *  via/track anchor while routing (see BoardPointerController.
	 *  computeWorkingPoint). drawBoardCrosshair() draws the crosshair HERE,
	 *  not at the raw pointer — this is what actually shows the user where a
	 *  snap is about to happen, continuously, for every crosshair mode, not
	 *  a one-off marker tied to a single tool (an earlier attempt at this
	 *  drew a separate marker only inside the route preview; the user wanted
	 *  the real crosshair cursor itself to do this, matching real KiCad). */
	protected workingPointWorld: Vec2 | null = null;
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
	/** True between a STRUCTURAL board AST mutation (add/delete/route/zone
	 *  edit/...) and the next full scene rebuild — see rebuildActiveScene()'s
	 *  board branch / rebuildBoardSceneIfPending(). Deferred to render()
	 *  (at most once per animation frame) rather than run synchronously,
	 *  since these can in principle fire faster than the display refresh
	 *  rate too and a full board rebuild is expensive regardless of cause. */
	protected boardStructureDirty = false;
	/** Footprints awaiting an INCREMENTAL rebuild — see
	 *  scheduleFootprintRebuild's doc comment. This is the path a
	 *  continuous drag (moveFootprintByPaintId/translateBoardSelection)
	 *  actually takes; boardStructureDirty above is the full-rebuild
	 *  fallback every other board mutation still uses. */
	protected boardDirtyFootprints = new Set<any>();
	/** Lazily-built id->name lookup for netNameForId, invalidated (set back
	 *  to null) alongside every full board scene rebuild — see
	 *  rebuildBoardSceneIfPending's boardStructureDirty branch. Net names
	 *  never change without a structural rebuild (the `(net id name)` table
	 *  itself is root-level board content, not something a footprint/track
	 *  drag ever touches), so this stays valid for the whole span between
	 *  rebuilds despite netNameForId being called many times per second
	 *  during a track/via drag's live collision preview (RouterNode's
	 *  firstSegmentCollision) — a plain linear findChildrenByClass scan
	 *  there was the single largest cost in a real dense-board drag trace. */
	protected netNameCache: Map<number, string> | null = null;
	protected copperGraphCache: { scene: LayeredBoardScene; graph: CopperGraph } | null = null;
	/** Footprints currently being dragged, KiCad VIEW-preview style (see
	 *  beginBoardDragPreview's doc comment): removed from the real scene (one
	 *  full static retessellation, not one per frame) and drawn instead
	 *  through the cheap per-frame dynamic path via drawBoardDragPreview,
	 *  using whatever items were last built for it here. Re-added to the real
	 *  scene (another one-time retessellation) at drag-end. */
	protected dragPreviewFootprints = new Map<any, PaintedItem[]>();
	/** Newly committed tracks stay in this tiny dynamic overlay until a later
	 * static rebuild naturally absorbs them; dropping a wire must not stall on
	 * retessellating an otherwise unchanged dense board. */
	protected committedTrackOverlay: PaintedItem[] = [];
	/** Ratsnest airwires whose 'from' or 'to' endpoint sits on a pad
	 *  currently under drag-preview — see beginBoardDragPreview's doc
	 *  comment and captureDragPreviewRatsnestEdges. Populated once at drag
	 *  start; updateBoardDragPreview() then just overwrites these specific
	 *  endpoints' coordinates every frame (O(edges touching the dragged
	 *  pads), typically a handful) instead of recomputing the net's whole
	 *  MST from scratch (O(pad count²) — confirmed via profiling as the
	 *  dominant per-frame cost on a busy net like GND, where "MST from
	 *  scratch every frame" is easily 100+ pads squared, 60 times a
	 *  second). Real KiCad does the same thing: a live drag re-anchors the
	 *  existing airwire endpoints, it doesn't re-solve connectivity —
	 *  that only happens once, for real, at drop (endBoardDragPreview). */
	protected dragPreviewRatsnestEdges: { lineIndex: number; padId: string; endpoint: 'from' | 'to' }[] = [];
	// See render()'s WebGL branch — only geometry-affecting changes (new
	// document, layer visibility/opacity, selection) need this; pure
	// pan/zoom/flip never do.
	protected geometryDirty = true;
	protected activeBoardDragPerformance: BoardDragPerformance | null = null;
	protected lastBoardDragPerformance: BoardDragPerformance | null = null;
	protected lastBoardDragFastRejection: string | null = null;
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
	/**
	 * True once resize() has actually stamped real dimensions into the canvas
	 * at least once. A fresh `<canvas>` with no width/height attribute
	 * defaults to 300×150 — comfortably above minFitViewportPx — so
	 * fitToItems()'s size check alone doesn't catch "this session's canvas
	 * has never been through a real resize() yet" (e.g. a document loaded
	 * while the editor screen is still `display:none`, before the first
	 * resize() call ever fires). Without this flag fitToItems() computes a
	 * real zoom/pan against that bogus 300×150 backing store, and the later
	 * resize() to the real size has nothing queued in pendingFitItems to
	 * retry — the camera stays fit for a viewport that never existed, and
	 * the schematic looks blank until something else (e.g. switching to the
	 * PCB view and back) happens to trigger another fit.
	 */
	protected hasResized = false;
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
		onBoardBarcodeEncoderReady(() => {
			if (this.documentType === 'board' && this.boardRoot) {
				this.boardStructureDirty = true;
				this.scheduleRender();
			}
		});

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

	/** Polymorphic counterpart to activeScene — the retained AST for
	 *  whichever document type is loaded, so mutation methods can be
	 *  generalized off their current schematic-only documentType guard. */
	get activeRoot(): { rootElement: any } | null {
		return this.documentType === 'schematic' ? this.schematicRoot : this.boardRoot;
	}

	get activeLayerState(): Map<string, LayerVisibilityState> | Map<string, SchLayerVisibilityState> {
		return this.documentType === 'schematic' ? this.schLayerState : this.layerState;
	}

	/** True only if `layer` has a known, visible state — matches the check
	 * already used at paint time (drawBoardDragPreview) so hit-testing can't
	 * select/drag an item whose layer is hidden in the Appearance panel. */
	protected isBoardLayerVisible(layer: string): boolean {
		const state = this.layerState.get(layer);
		return !!state && state.visible;
	}

	protected isSchLayerVisible(layer: string): boolean {
		const state = this.schLayerState.get(layer);
		return !!state && state.visible;
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

	/** When true, board builds include pad-number overlays (PadNumbers
	 *  layer). Defaults to true, matching real KiCad. Toggling forces a
	 *  full board scene rebuild so an already-loaded board picks it up
	 *  immediately. */
	get showPadNumbers(): boolean {
		return !!this.painter.options.showPadNumbers;
	}

	set showPadNumbers(value: boolean) {
		if (this.painter.options.showPadNumbers === value) {
			return;
		}
		this.painter.options.showPadNumbers = value;
		this.rebuildBoardPaintOptions();
	}

	/** When true, board builds include each pad's net name alongside its
	 *  number (stacked as a 2-line block when both are on). Defaults to
	 *  true, matching real KiCad. Toggling forces a full board scene
	 *  rebuild so an already-loaded board picks it up immediately. */
	get showNetNames(): boolean {
		return !!this.painter.options.showNetNames;
	}

	set showNetNames(value: boolean) {
		if (this.painter.options.showNetNames === value) {
			return;
		}
		this.painter.options.showNetNames = value;
		this.rebuildBoardPaintOptions();
	}

	/** Common tail for showPadNumbers/showNetNames setters — a paint-option
	 *  flip changes what buildFootprint() emits, so the static scene must
	 *  be fully rebuilt from the AST, same as any other structural board
	 *  edit (see rebuildActiveScene's board branch). No-ops for schematics
	 *  or before a board is loaded. */
	private rebuildBoardPaintOptions(): void {
		if (this.documentType !== 'board' || !this.boardRoot) {
			return;
		}
		this.boardStructureDirty = true;
		this.scheduleRender();
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
		this.hasResized = true;
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
			? (this.schScene ? hitTest(
				this.schScene.hitTestItems, worldPos.x, worldPos.y, tolerance,
				item => item.kind === 'symbol' || this.isSchLayerVisible(item.layer)
			) : null)
			: (this.scene ? hitTest(
				this.scene.hitTestItems, worldPos.x, worldPos.y, tolerance,
				item => item.kind === 'footprint' || this.isBoardLayerVisible(item.layer)
			) : null);
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

	/** Board-only counterpart to hitTestAtScreen for ambiguous clicks —
	 *  collects every candidate under the cursor and reduces them with a
	 *  simplified port of real KiCad's GuessSelectionCandidates
	 *  (pcb_selection_tool.cpp:4564): a cascading bbox-area-ratio cutoff
	 *  (not exact polygon coverage — real KiCad's own per-type precision is
	 *  a stated simplification here) followed by an active-layer tie-break.
	 *  NOT ported: the silk/courtyard active-layer preference tier, the
	 *  hit-distance "sloppiness" pre-filter (shapeContainsPoint already only
	 *  returns genuine contains-point hits, so raw candidates here are
	 *  already fairly tight), and the footprint-mostly-covered rescue case.
	 *  `reduced.length` is 0 (nothing hit), 1 (unambiguous —
	 *  BoardPointerController should behave exactly as before this feature
	 *  existed), or >1 (caller should show a disambiguation popup). `all` is
	 *  the unreduced list, exposed so the caller can build "Show More
	 *  Choices…" without a second, separately-tolerance/worldPos-computed
	 *  hit-test call. Both stay topmost-first. `activeLayer` is optional so
	 *  callers who don't care about the tie-break can omit it. */
	hitTestCandidatesAtScreen(screenPos: Vec2, activeLayer?: string): { reduced: HitResult[]; all: HitResult[] } {
		if (this.documentType !== 'board' || !this.scene) {
			return { reduced: [], all: [] };
		}
		const worldPos = this.screenToWorld(screenPos);
		const tolerance = this.hitTestToleranceWorld();
		const raw = hitTestAll(
			this.scene.hitTestItems, worldPos.x, worldPos.y, tolerance,
			item => item.kind === 'footprint' || this.isBoardLayerVisible(item.layer)
		);
		return {
			reduced: this.reduceHitCandidates(raw, activeLayer).map(item => this.toBoardHitResult(item)),
			all: raw.map(item => this.toBoardHitResult(item))
		};
	}

	/** The area-ratio cascade + active-layer tie-break described on
	 *  hitTestCandidatesAtScreen. Sorts ascending by bbox area and walks the
	 *  list, rejecting everything from the first point where an item's area
	 *  exceeds the PREVIOUS item's area by more than 1.5x (a chained
	 *  threshold, not a comparison against the global smallest — matches
	 *  GuessSelectionCandidates' own `itemsByArea[i-1] * sizeRatio` check
	 *  exactly, pcb_selection_tool.cpp:4705-4712). */
	protected reduceHitCandidates(candidates: PaintedItem[], activeLayer?: string): PaintedItem[] {
		if (candidates.length <= 1) {
			return candidates;
		}
		const byArea = candidates
			.map(item => ({ item, area: this.candidateArea(item) }))
			.sort((a, b) => a.area - b.area);
		let cutIndex = byArea.length;
		for (let i = 1; i < byArea.length; i++) {
			if (byArea[i]!.area > byArea[i - 1]!.area * 1.5) {
				cutIndex = i;
				break;
			}
		}
		let result = byArea.slice(0, cutIndex).map(entry => entry.item);
		if (result.length > 1 && activeLayer) {
			// A via's own `layer` is the synthetic 'Vias' bucket, not a real
			// copper layer, so it never equals activeLayer — without this
			// exemption, a via that survived the area cutoff above (tied with
			// a same-spot track) got dropped right back out here, since only
			// the track ever matches. A via conceptually belongs to every
			// copper layer it bridges, so it should never lose this tie-break
			// at all.
			const onActiveLayer = result.filter(item => item.layer === activeLayer || item.kind === 'via');
			if (onActiveLayer.length > 0) {
				result = onActiveLayer;
			}
		}
		return result;
	}

	/** Real KiCad's own GuessSelectionCandidates (pcb_selection_tool.cpp
	 *  ~4657-4664) deliberately shrinks a via's notional area from its full
	 *  bbox (πr²) down to just its drill hole (r²) specifically so it never
	 *  loses a same-spot area-ratio comparison to whichever track
	 *  segment(s) necessarily terminate exactly at its center — literally
	 *  every via with anything wired to it has this exact ambiguity, by
	 *  construction. Without this, which of {via, track} came out
	 *  numerically smaller (and therefore survived reduceHitCandidates'
	 *  cutoff) depended on the connected segment's own incidental length,
	 *  so clicking a via was a coin flip between actually hitting the via
	 *  and hitting its own track instead — root-caused against a real
	 *  board where one via consistently resolved to 'via' and a second,
	 *  otherwise identical one consistently resolved to 'track-endpoint',
	 *  making it impossible to ever drag. */
	protected candidateArea(item: PaintedItem): number {
		if (item.kind === 'via' && typeof (item.element as any)?.getDrill === 'function') {
			// getDrill() returns { width, height? } (WithDrill.ts), not a bare
			// number — using the object itself here (always truthy) silently
			// fell through to the old bbox-area path every time, which is
			// exactly why this fix didn't take effect on first pass.
			const width = (item.element as any).getDrill()?.width;
			if (typeof width === 'number' && width > 0) {
				return width * width;
			}
		}
		return item.bbox.w * item.bbox.h;
	}

	protected toBoardHitResult(item: PaintedItem): HitResult {
		const length = item.kind === 'track' && item.shape.type === 'segment'
			? Math.hypot(item.shape.x2 - item.shape.x1, item.shape.y2 - item.shape.y1)
			: undefined;
		return { id: item.id, kind: item.kind, layer: item.layer, netName: item.netName, length };
	}

	/** Given an already-hit track (kind:'track') paint id, reports which end
	 *  ('start'/'end') the given screen position is closest to, if within
	 *  pick tolerance of that specific endpoint — null if the click landed
	 *  mid-track (a mid-segment click starts a body drag instead, see
	 *  assembleTrackLine).
	 *
	 *  Real KiCad's own corner-vs-body split (DRAGGER::startDragSegment,
	 *  pns_dragger.cpp) isn't a fixed pixel radius at all — it's the
	 *  segment's own drawn half-width, i.e. "click anywhere on the round
	 *  end-cap counts as the corner". Using only the fixed hit-test pixel
	 *  tolerance here made clicking a fat track's visible end-cap (bigger
	 *  on screen than the tiny tolerance circle at its exact vertex) fall
	 *  through to a body drag instead of the corner/extend drag the
	 *  end-cap visually promises — reported as "insists on dragging that
	 *  segment" instead of letting a dangling end be extended/reconnected.
	 *  max() with the usual pixel tolerance keeps thin tracks just as
	 *  clickable as before; it only widens the target for thick ones. */
	trackEndpointNear(paintId: string, screenPos: Vec2): 'start' | 'end' | null {
		if (this.documentType !== 'board' || !this.scene) {
			return null;
		}
		const item = this.scene.hitTestItems.find(it => it.id === paintId);
		if (!item || item.kind !== 'track' || item.shape.type !== 'segment') {
			return null;
		}
		const worldPos = this.screenToWorld(screenPos);
		const tolerance = Math.max(this.hitTestToleranceWorld(), item.shape.width / 2);
		const dStart = Math.hypot(worldPos.x - item.shape.x1, worldPos.y - item.shape.y1);
		const dEnd = Math.hypot(worldPos.x - item.shape.x2, worldPos.y - item.shape.y2);
		if (dStart <= tolerance && dStart <= dEnd) {
			return 'start';
		}
		if (dEnd <= tolerance) {
			return 'end';
		}
		return null;
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
			labelKind: hit.labelKind
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
			for (const id of ids) {
				this.selectedIds.add(id);
			}
		}
		else {
			for (const id of ids) {
				this.selectedIds.delete(id);
			}
		}
		// Board selection now draws through paintHighlightOverlay's cheap
		// per-frame dynamic pass (see render()'s own doc comment) — no full
		// static geometry rebuild needed just to recolor 1-2 items, which
		// used to cost the same as loading the whole board on every click.
		// Schematic selection is unchanged for now (still baked per-vertex at
		// build time — see setLayerVisible()'s comment) — a separately-scoped
		// follow-up, not a forgotten case.
		if (this.documentType !== 'board') {
			this.geometryDirty = true;
		}
		this.scheduleRender();
	}

	/** Real KiCad's "Select/Expand Connection" (U key, pcb_selection_tool.cpp
	 *  :2146 expandConnection / :2230 selectAllConnectedTracks) — ported
	 *  against buildCopperGraph's point-level connectivity (paint/
	 *  BoardCopperGraph.ts) rather than re-deriving touching-copper
	 *  detection here. Seeds from the current selection's track/via/pad
	 *  items — footprints and non-copper graphics are out of scope (a
	 *  stated simplification: this app's workflow is always "select a
	 *  track/via/pad first, then press U", unlike real KiCad's additional
	 *  empty-selection/graphic-shape fallback paths, pcb_selection_tool.cpp
	 *  :2163-2179).
	 *
	 *  Tries three stop tiers in order — junction, pad, whole net —
	 *  escalating to the next only if the previous one didn't grow the
	 *  selection, exactly matching real KiCad's own auto-escalating retry
	 *  loop (:2183-2219): no press-counter needed, each press just
	 *  re-derives from the CURRENT selection size. "Junction" mirrors real
	 *  KiCad's pt_count (more than 2 track-kind neighbors at one physical
	 *  point = a T-branch) via the adjacency graph itself — see
	 *  CopperGraph.adjacent's doc comment for why this needs no separate
	 *  detection pass. "Whole net" is answered directly by the union-find
	 *  (graph.find) rather than walked, since that's exactly what an
	 *  electrical island already is.
	 *
	 *  Returns the number of newly-selected items (0 if there was nothing
	 *  track/via/pad-shaped selected to seed from, or nothing more to add). */
	expandBoardConnection(): number {
		if (this.documentType !== 'board' || !this.scene) {
			return 0;
		}
		const graph = this.currentCopperGraph();
		const seedIds = new Set(this.selectedIds);
		const seedNodeIndices = graph.nodes
			.map((node, index) => ({ node, index }))
			.filter(({ node }) => seedIds.has(node.itemId))
			.map(({ index }) => index);
		if (seedNodeIndices.length === 0) {
			return 0;
		}
		const initialCount = this.selectedIds.size;

		const branchCount = (index: number): number =>
			graph.adjacent(index).filter(other => graph.nodes[other]!.itemKind === 'track').length;

		// Real KiCad's selectAllConnectedTracks never calls select() on a
		// pad — only push its position as a new active point so the walk can
		// continue through it (e.g. a through-hole pad bridging layers). A
		// pad is a pass-through node, not a selectable/deletable result:
		// pressing U must never grow the selection into the footprint the
		// pad belongs to.
		const toSelectableIds = (nodeIndices: Iterable<number>): Set<string> => {
			const ids = new Set<string>();
			for (const nodeIndex of nodeIndices) {
				const node = graph.nodes[nodeIndex]!;
				if (node.itemKind !== 'pad') {
					ids.add(node.itemId);
				}
			}
			return ids;
		};

		const walk = (stopMode: 'junction' | 'pad'): Set<number> => {
			const visited = new Set(seedNodeIndices);
			let frontier = [...seedNodeIndices];
			while (frontier.length > 0) {
				const next: number[] = [];
				for (const nodeIndex of frontier) {
					for (const neighborIndex of graph.adjacent(nodeIndex)) {
						if (visited.has(neighborIndex)) {
							continue;
						}
						visited.add(neighborIndex);
						const neighbor = graph.nodes[neighborIndex]!;
						const isStartPad = neighbor.itemKind === 'pad' && seedIds.has(neighbor.itemId);
						// Real KiCad's own stop rule (pcb_selection_tool.cpp
						// :2423-2446): JUNCTION always stops at a via and at
						// any pad other than one you started from; PAD only
						// stops at a non-start pad (vias and branches are
						// freely crossable at that tier).
						const stopHere = stopMode === 'junction'
							? (neighbor.itemKind === 'via'
								|| (neighbor.itemKind === 'pad' && !isStartPad)
								|| (neighbor.itemKind === 'track' && branchCount(neighborIndex) > 2))
							: (neighbor.itemKind === 'pad' && !isStartPad);
						if (!stopHere) {
							next.push(neighborIndex);
						}
					}
				}
				frontier = next;
			}
			return visited;
		};
		const wholeIslands = (): Set<number> => {
			const roots = new Set(seedNodeIndices.map(index => graph.find(index)));
			const result = new Set<number>();
			for (let index = 0; index < graph.nodes.length; index++) {
				if (roots.has(graph.find(index))) {
					result.add(index);
				}
			}
			return result;
		};

		let resultIds: Set<string> | null = null;
		for (const tier of ['junction', 'pad', 'never'] as const) {
			const visited = tier === 'never' ? wholeIslands() : walk(tier);
			const grownIds = new Set([...this.selectedIds, ...toSelectableIds(visited)]);
			if (grownIds.size > initialCount || tier === 'never') {
				resultIds = grownIds;
				break;
			}
		}
		if (!resultIds) {
			return 0;
		}
		const addedCount = resultIds.size - this.selectedIds.size;
		if (addedCount > 0) {
			this.selectMultiple([...resultIds], 'replace');
		}
		return addedCount;
	}

	clearNetHighlight(): void {
		if (!this.highlightedNetIds.size && this.highlightedNetName === null) {
			return;
		}
		this.highlightedNetName = null;
		this.highlightedNetIds.clear();
		this.scheduleRender();
	}

	get currentHighlightedBoardNetName(): string | null { return this.highlightedBoardNetName; }

	/** Board counterpart of highlightNetAtScreen — clicking a pad/track/via/
	 *  zone highlights every other item on that net and dims the rest of the
	 *  board's copper. WebGL bakes item color into its static vertex buffer
	 *  (same as selectMultiple's own highlight color), so this needs the same
	 *  geometryDirty rebuild that method uses, not just scheduleRender(). */
	highlightBoardNetAtScreen(screenPos: Vec2): boolean {
		if (this.documentType !== 'board' || !this.scene) {
			this.clearBoardNetHighlight();
			return false;
		}
		const hit = this.hitTestAtScreen(screenPos);
		const item = hit ? this.scene.hitTestItems.find(candidate => candidate.id === hit.id) : null;
		const netId = item?.netId ?? null;
		if (netId === null || netId <= 0) {
			this.clearBoardNetHighlight();
			return false;
		}
		if (this.highlightedBoardNetId === netId) {
			return true;
		}
		this.highlightedBoardNetId = netId;
		// Tracks/vias reference a net by ID only ("(net 5)") — the name lives
		// on whichever item actually carries it (pads write "(net 5 "GND")"),
		// so a bare-ID hit falls back to scanning for that name instead of
		// showing a blank one.
		this.highlightedBoardNetName = item?.netName
			|| this.scene.hitTestItems.find(candidate => candidate.netId === netId && candidate.netName)?.netName
			|| null;
		this.geometryDirty = true;
		this.scheduleRender();
		return true;
	}

	clearBoardNetHighlight(): void {
		if (this.highlightedBoardNetId === null) {
			return;
		}
		this.highlightedBoardNetId = null;
		this.highlightedBoardNetName = null;
		this.geometryDirty = true;
		this.scheduleRender();
	}

	/**
	 * Outlines the footprint whose Reference property matches `ref` — see
	 * boardHighlight's doc comment. Pass null (or a ref not found on this
	 * board) to clear. No-op outside a loaded board — a PCB tab is the only
	 * place this makes sense to call.
	 */
	setFootprintHighlight(ref: string | null): void {
		if (this.documentType !== 'board' || !this.scene) {
			return;
		}
		const bbox = ref ? this.findFootprintBBoxByRef(ref) : null;
		this.boardHighlight = bbox ? { bbox } : null;
		this.scheduleRender();
	}

	/** Unions the bboxes of every PaintedItem belonging to the footprint
	 *  whose Reference property matches `ref` — pads, silkscreen outline,
	 *  and the reference/value text itself all share an id prefix (see
	 *  BoardPainter.buildFootprint's footprintId), so this doesn't need any
	 *  AST access beyond what the already-built scene's items carry. */
	protected findFootprintBBoxByRef(ref: string): { x: number; y: number; w: number; h: number } | null {
		const scene = this.scene;
		if (!scene) {
			return null;
		}
		let footprintId: string | null = null;
		outer: for (const items of scene.layerBuckets.values()) {
			for (const item of items) {
				if (item.kind !== 'footprint-ref') {
					continue;
				}
				const element = item.element;
				if (typeof element?.getPropertyByName !== 'function') {
					continue;
				}
				if (element.getPropertyByName('Reference')?.propertyValue === ref) {
					const separatorIndex = item.id.indexOf(':prop:');
					footprintId = separatorIndex >= 0 ? item.id.slice(0, separatorIndex) : null;
					break outer;
				}
			}
		}
		if (!footprintId) {
			return null;
		}
		const prefix = `${ footprintId }:`;
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const items of scene.layerBuckets.values()) {
			for (const item of items) {
				if (!item.id.startsWith(prefix)) {
					continue;
				}
				minX = Math.min(minX, item.bbox.x);
				minY = Math.min(minY, item.bbox.y);
				maxX = Math.max(maxX, item.bbox.x + item.bbox.w);
				maxY = Math.max(maxY, item.bbox.y + item.bbox.h);
			}
		}
		if (!Number.isFinite(minX)) {
			return null;
		}
		return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
	}

	/** Board-only: walks a hit element's parent chain up to the owning
	 *  KicadElementFootprint — a pad's own (at x y)/layers are footprint-
	 *  LOCAL (only converted to world space/absolute layer at paint time), so
	 *  every footprint mutation entry point needs to resolve to the
	 *  footprint itself before touching origin/layer, never mutate a hit pad
	 *  directly. Also handles a hit that's already the footprint's own
	 *  synthetic whole-body item (element is already a KicadElementFootprint,
	 *  loop body never runs) — see BoardPainter.buildFootprint's `kind:
	 *  'footprint'` item. */
	private footprintOwnerOfHit(paintId: string): any | null {
		const item = this.scene?.hitTestItems.find(it => it.id === paintId);
		let el: any = item?.element;
		while (el && !(el instanceof KicadElementFootprint)) {
			el = el.parent;
		}
		if (el) {
			return el;
		}
		// A footprint under an active drag-preview (see beginBoardDragPreview)
		// is deliberately absent from scene.hitTestItems for the rest of the
		// gesture, so the lookup above can never find it there — every
		// subsequent moveFootprintByPaintId/translateBoardSelection call
		// during that same drag still needs to resolve it, so fall back to
		// matching its own uuid against the preview set.
		for (const footprint of this.dragPreviewFootprints.keys()) {
			if (footprint.getUuid?.() === paintId) {
				return footprint;
			}
		}
		return null;
	}

	/** Public counterpart to footprintOwnerOfHit — resolves ANY board hit id
	 *  (a pad, or the footprint's own synthetic whole-body item) to that
	 *  footprint's own canonical paint id; returns the input unchanged for
	 *  anything that isn't part of a footprint (track/via/zone), or outside
	 *  a board document. Board callers should normalize through this ONCE
	 *  at hit/select time — e.g. BoardPointerController.onMouseDown — so
	 *  selectedIds always holds footprint-level ids, never pad-level ones
	 *  (a pad's own id would never match a footprint id already sitting in
	 *  a multi-selection, silently breaking group-drag membership checks). */
	footprintPaintIdForHit(paintId: string): string {
		if (this.documentType !== 'board') {
			return paintId;
		}
		const el = this.footprintOwnerOfHit(paintId);
		return el?.getUuid?.() ?? paintId;
	}

	/** Moves the footprint owning the given paint id to an absolute board
	 *  position — `paintId` may be a pad hit or the footprint's own
	 *  synthetic whole-body hit item, see footprintOwnerOfHit. */
	moveFootprintByPaintId(paintId: string, x: number, y: number): boolean {
		if (this.documentType !== 'board' || !this.boardRoot || !this.scene) {
			return false;
		}
		const el = this.footprintOwnerOfHit(paintId);
		if (!el) {
			return false;
		}
		// setOrigin's rotation param defaults to 0 when omitted — passing the
		// footprint's current rotation through explicitly is required, not
		// optional, or every drag would silently un-rotate the part.
		const rotation = el.getOrigin().rotation;
		el.setOrigin(x, y, rotation);
		this.scheduleFootprintRebuild(el);
		return true;
	}

	/** Rotates the footprint owning the given paint id in place around its
	 * own origin. Footprint-local positions follow the parent matrix, but
	 * KiCad serializes pad and text angles in the board frame. Their angles
	 * therefore need the same delta as the footprint (KiCad's
	 * FOOTPRINT::SetOrientation() / PCB_TEXT::OnFootprintTransformed()). */
	rotateFootprintByPaintId(paintId: string, degrees: number): boolean {
		if (this.documentType !== 'board' || !this.boardRoot || !this.scene) {
			return false;
		}
		const el = this.footprintOwnerOfHit(paintId);
		if (!el) {
			return false;
		}
		this.pushUndoSnapshot('Rotate footprint');
		const origin = el.getOrigin();
		const newRotation = ((origin.rotation + degrees) % 360 + 360) % 360;
		el.setOrigin(origin.x, origin.y, newRotation);
		for (const pad of el.findChildrenByClass(KicadElementPad)) {
			const padOrigin = pad.getOrigin();
			const newPadRotation = ((padOrigin.rotation + degrees) % 360 + 360) % 360;
			pad.setOrigin(padOrigin.x, padOrigin.y, newPadRotation);
		}
		this.rebuildAfterFootprintGeometryEdit(el);
		return true;
	}

	/** Flips the footprint owning the given paint id to the other side of
	 *  the board: swaps its own F./B. layer prefix and negates rotation,
	 *  matching real KiCad's FOOTPRINT::Flip() core (footprint.cpp:2976).
	 *  Deliberately simplified vs. real KiCad: does NOT remap each pad's own
	 *  per-layer padstack set (PAD::Flip()'s per-layer LSET rebuild) — an
	 *  asymmetric custom pad layer set will end up visually/electrically
	 *  wrong after this until that's added. Flagged as a known gap, not
	 *  attempted here to keep this phase scoped to footprint placement. */
	flipFootprintByPaintId(paintId: string): boolean {
		if (this.documentType !== 'board' || !this.boardRoot || !this.scene) {
			return false;
		}
		const el = this.footprintOwnerOfHit(paintId);
		if (!el || typeof el.setLayer !== 'function' || typeof el.getLayer !== 'function') {
			return false;
		}
		this.pushUndoSnapshot('Flip footprint');
		const currentLayer: string = el.getLayer();
		const flipped = currentLayer.startsWith('F.') ? `B.${ currentLayer.slice(2) }`
			: currentLayer.startsWith('B.') ? `F.${ currentLayer.slice(2) }` : currentLayer;
		el.setLayer(flipped);
		const origin = el.getOrigin();
		const newRotation = ((360 - origin.rotation) % 360 + 360) % 360;
		el.setOrigin(origin.x, origin.y, newRotation);
		this.rebuildAfterFootprintGeometryEdit(el);
		return true;
	}

	/** Board-side rect-select — deliberately simpler than schematic's
	 *  hitTestRect: boards have no group/nested-library-definition concept,
	 *  so no root-children membership filter is needed. Pads ARE excluded
	 *  though — a pad's bbox is always a subset of its owning footprint's
	 *  synthetic 'footprint' item bbox (see BoardPainter.buildFootprint), so
	 *  including them would only ever add redundant/partial-footprint ids;
	 *  callers get whole-footprint (or track/via/zone) granularity only. */
	hitTestBoardRect(worldOrigin: Vec2, worldCursor: Vec2, mode: 'contained' | 'touching'): string[] {
		if (this.documentType !== 'board' || !this.scene) {
			return [];
		}
		const minX = Math.min(worldOrigin.x, worldCursor.x);
		const maxX = Math.max(worldOrigin.x, worldCursor.x);
		const minY = Math.min(worldOrigin.y, worldCursor.y);
		const maxY = Math.max(worldOrigin.y, worldCursor.y);
		const result: string[] = [];
		for (const item of this.scene.hitTestItems) {
			if (item.kind === 'pad') {
				continue;
			}
			if (item.kind !== 'footprint' && !this.isBoardLayerVisible(item.layer)) {
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

	/** Group-drag primitive for a board selection. Pads resolve to their
	 *  owning footprint so a component moves as one unit; board-level items
	 *  such as tracks, vias, graphics and zones move through the same generic
	 *  geometry translation used by schematic items. */
	translateBoardSelection(ids: string[], dx: number, dy: number): boolean {
		if (this.documentType !== 'board' || !this.boardRoot || !this.scene || (dx === 0 && dy === 0)) {
			return false;
		}
		const footprints = new Set<any>();
		const elements = new Set<any>();
		for (const id of ids) {
			const item = this.scene.hitTestItems.find(candidate => candidate.id === id);
			// A footprint's own field (Reference/Value/custom) moves
			// independently — real KiCad keeps these individually draggable
			// outside the footprint editor (confirmed against
			// pcb_selection_tool.cpp's Selectable(): PCB_FIELD_T/PCB_TEXT_T
			// stay pickable, unlike a pad, which always drags the WHOLE
			// footprint). Checked by item KIND, not by walking the element's
			// own parent chain — footprintOwnerOfHit below would otherwise
			// resolve a field straight past this and move the whole
			// footprint, since a field's own .parent IS the footprint.
			if (item?.kind === 'footprint-ref') {
				elements.add(item.element);
				continue;
			}
			const el = this.footprintOwnerOfHit(id);
			if (el) {
				footprints.add(el);
				continue;
			}
			if (item) {
				elements.add(item.element);
			}
		}
		if (footprints.size === 0 && elements.size === 0) {
			return false;
		}
		let moved = false;
		for (const fp of footprints) {
			const origin = fp.getOrigin();
			fp.setOrigin(origin.x + dx, origin.y + dy, origin.rotation);
			moved = true;
			// Incremental — see scheduleFootprintRebuild's doc comment.
			this.scheduleFootprintRebuild(fp);
		}
		for (const el of elements) {
			if (this.translateElementGeometry(el, dx, dy)) {
				moved = true;
			}
		}
		if (elements.size > 0) {
			// No incremental rebuild path for bare tracks/vias/graphics yet —
			// fall back to a full rebuild for those (a mixed footprint+track
			// group-drag is rare; footprints above already got the fast path
			// regardless of this).
			this.rebuildActiveScene();
		}
		return moved;
	}

	/**
	 * Resolves a board selection into what a FAST, incremental drag needs
	 * — every STATIC ITEM id whose GPU geometry must shift (every one of a
	 * dragged footprint's own pads/graphics/text, or a single field's own
	 * item), plus the AST elements (footprints and/or fields) whose own
	 * `(at x y)` origin must update to match. A footprint drag was
	 * previously the ONE case that still cost a full static rebuild even
	 * after selection itself got moved off that path — see
	 * translateBoardDragFast's own doc comment for the mechanism this
	 * feeds.
	 *
	 * Returns `null` (no fast path) for anything this doesn't cover yet: a
	 * bare track/via/graphic in the selection (translateBoardSelection's
	 * own `rebuildActiveScene()` fallback already handles those), or a
	 * footprint with no real uuid to key its own items by. Callers must
	 * fall back to the slower beginBoardDragPreview path for the WHOLE
	 * gesture in that case — never attempt a partial fast path.
	 */
	resolveBoardDragTargets(ids: readonly string[]): { itemIds: string[]; origins: any[]; bboxOnlyItems: PaintedItem[] } | null {
		this.lastBoardDragFastRejection = null;
		if (this.documentType !== 'board' || !this.scene) {
			this.lastBoardDragFastRejection = 'no-board-scene';
			return null;
		}
		const footprints = new Set<any>();
		const fields = new Set<any>();
		for (const id of ids) {
			const item = this.scene.hitTestItems.find(candidate => candidate.id === id);
			if (item?.kind === 'footprint-ref') {
				fields.add(item.element);
				continue;
			}
			const el = this.footprintOwnerOfHit(id);
			if (el) {
				footprints.add(el);
				continue;
			}
			this.lastBoardDragFastRejection = 'unsupported-selection';
			return null;
		}
		if (footprints.size === 0 && fields.size === 0) {
			this.lastBoardDragFastRejection = 'empty-selection';
			return null;
		}
		const itemIds: string[] = [];
		const bboxOnlyItems: PaintedItem[] = [];
		for (const fp of footprints) {
			const uuid: string | null = typeof fp.getUuid === 'function' ? fp.getUuid() : null;
			if (!uuid) {
				this.lastBoardDragFastRejection = 'missing-footprint-uuid';
				return null;
			}
			for (const bucket of this.scene.layerBuckets.values()) {
				for (const item of bucket) {
					if (item.id !== uuid && !item.id.startsWith(`${ uuid }:`)) {
						continue;
					}
					if (item.kind === 'footprint') {
						// The synthetic whole-footprint hit item never draws
						// real geometry (its own draw() is a no-op — see
						// BoardPainter.buildFootprint's own comment); it
						// exists only so paintHighlightOverlay has a bbox to
						// outline when this footprint is selected. Nothing
						// for translateStaticItems to shift — its bbox/shape
						// move directly instead (see translateBoardDragFast)
						// so the selection outline still tracks the drag live
						// instead of visibly lagging a frame behind.
						bboxOnlyItems.push(item);
						continue;
					}
					if (!item.layer) {
						// Never actually drawn: BoardPainter.paint()'s own
						// per-layer loop only ever visits real, known layer
						// names, so an item with no declared layer at all
						// (e.g. an internal-only footprint property like
						// "ki_fp_filters" with no `(layer ...)` of its own)
						// never reached item.draw() and so was never tracked
						// by WebGLRenderer's beginItem/endItem to begin with.
						// A real, separately-flagged latent gap (such an item
						// is also invisible and non-hit-testable through the
						// normal path, for the same underlying reason) — not
						// something this fast path needs to move, since
						// there's nothing visible to move.
						continue;
					}
					// Hidden-layer items never entered the static buffer, so asking
					// WebGL to translate them makes an otherwise eligible footprint
					// drag fail atomically. PadNumbers is the sole synthetic layer
					// that BoardPainter intentionally renders without a layer-state.
					if (item.layer !== 'PadNumbers' && !this.isBoardLayerVisible(item.layer)) {
						continue;
					}
					itemIds.push(item.id);
				}
			}
		}
		for (const field of fields) {
			const item = this.scene.hitTestItems.find(candidate => candidate.element === field);
			if (!item) {
				this.lastBoardDragFastRejection = 'field-not-in-scene';
				return null;
			}
			itemIds.push(item.id);
		}
		return { itemIds, origins: [...footprints, ...fields], bboxOnlyItems };
	}

	/**
	 * The fast per-frame drag primitive `resolveBoardDragTargets` feeds:
	 * shifts the already-baked static GPU geometry for every one of
	 * `targets.itemIds` by (dx, dy) with NO re-tessellation
	 * (WebGLRenderer.translateStaticItems — see its own doc comment for
	 * why a pure translation never needs one), then applies the same delta
	 * to each of `targets.origins`' own `(at x y)` so the AST — undo
	 * snapshots, save, everything downstream — agrees with what's on
	 * screen. This is what actually fixes a footprint drag's "first move
	 * is laggy, then fast" symptom: beginBoardDragPreview previously
	 * needed a full static rebuild just to temporarily hide the dragged
	 * footprint before the very first frame could even draw a preview;
	 * this needs no such rebuild at any point during the drag.
	 *
	 * Returns false (and mutates NOTHING — not even the AST) if the
	 * renderer doesn't support incremental translation at all (Canvas2D),
	 * or if it does but some item in `targets.itemIds` can't be
	 * incrementally shifted (see translateStaticItems' own doc comment on
	 * when that happens) — the caller must fall back to
	 * beginBoardDragPreview/translateBoardSelection/updateBoardDragPreview
	 * for the rest of the gesture in that case.
	 */
	translateBoardDragFast(targets: { itemIds: string[]; origins: any[]; bboxOnlyItems: PaintedItem[] }, dx: number, dy: number): boolean {
		this.lastBoardDragFastRejection = null;
		if (this.documentType !== 'board' || (dx === 0 && dy === 0)) {
			this.lastBoardDragFastRejection = 'invalid-delta-or-document';
			return false;
		}
		if (!this.webglRenderer || typeof this.webglRenderer.translateStaticItems !== 'function') {
			this.lastBoardDragFastRejection = 'renderer-does-not-support-translation';
			return false;
		}
		if (!this.webglRenderer.translateStaticItems(targets.itemIds, dx, dy)) {
			this.lastBoardDragFastRejection = 'static-item-range-missing';
			return false;
		}
		for (const el of targets.origins) {
			const origin = el.getOrigin();
			el.setOrigin(origin.x + dx, origin.y + dy, origin.rotation);
		}
		// The synthetic whole-footprint hit item(s) — see
		// resolveBoardDragTargets' own comment on why these are handled
		// separately from translateStaticItems: no real drawn geometry to
		// shift on the GPU side, just a bbox/shape paintHighlightOverlay
		// reads every frame to draw the selection outline. Without this,
		// the outline would visibly freeze at the pre-drag position for the
		// whole gesture instead of tracking it live.
		for (const item of targets.bboxOnlyItems) {
			item.bbox = { x: item.bbox.x + dx, y: item.bbox.y + dy, w: item.bbox.w, h: item.bbox.h };
			if (item.shape.type === 'polygon') {
				item.shape = { ...item.shape, points: item.shape.points.map(p => ({ x: p.x + dx, y: p.y + dy })) };
			}
		}
		return true;
	}

	/**
	 * Drag-END counterpart to translateBoardDragFast — refreshes the
	 * LOGICAL scene data (hit-test bboxes, each PaintedItem's own draw()
	 * closure) for everything the fast path touched, so a LATER full
	 * rebuild triggered by something else entirely (toggling a layer,
	 * editing a zone, anything) doesn't silently snap this back to its
	 * pre-drag position: every PaintedItem's draw() closure still captures
	 * whatever coordinates were current when IT was last built from the
	 * AST — translateBoardDragFast's own per-frame calls kept the GPU
	 * buffer and the AST itself correct throughout the drag, but never
	 * touched these closures. Deliberately does NOT set geometryDirty —
	 * the GPU buffer is already right; this only catches up the CPU-side
	 * scene data to match it.
	 */
	commitBoardDragFast(targets: { itemIds: string[]; origins: any[]; bboxOnlyItems: PaintedItem[] }): void {
		if (this.documentType !== 'board' || !this.boardRoot || !this.scene) {
			return;
		}
		const footprintsToRefresh = new Set<any>();
		for (const el of targets.origins) {
			if (el instanceof KicadElementFootprint) {
				footprintsToRefresh.add(el);
				continue;
			}
			// A field/property — refresh its OWNING footprint instead (which
			// also covers the field itself, since it lives inside it).
			let owner: any = el.parent;
			while (owner && !(owner instanceof KicadElementFootprint)) {
				owner = owner.parent;
			}
			if (owner) {
				footprintsToRefresh.add(owner);
			}
		}
		for (const fp of footprintsToRefresh) {
			this.painter.updateFootprintItems(this.scene, this.boardRoot, fp);
		}
		// Fix 3 — incremental drop: a fast-drag commit that leaves the moved
		// footprint(s) at the SAME positions as the previous commit (e.g. a
		// re-render / duplicate MouseUp on an already-baked position, or a
		// component dragged in place) must not re-run the whole net-scoped
		// copper-graph build — identical positions mean identical connectivity,
		// so the ratsnest is already correct. Keyed by footprint uuid + origin
		// on the current scene; any real movement changes the key and forces a
		// fresh (now much cheaper, post Fix 1+2) rebuild.
		const signature = this.ratnestCommitSignature(footprintsToRefresh);
		if (signature !== null && signature === this.lastRatsnestCommitSignature) {
			// Same positions as last commit — ratsnest already correct.
			this.lastRatsnestCommitSignature = signature;
			return;
		}
		this.copperGraphCache = null;
		const ratsnestStartedAt = performance.now();
		this.refreshRatsnestForFootprints(footprintsToRefresh);
		if (this.activeBoardDragPerformance) {
			this.activeBoardDragPerformance.ratsnestMs += performance.now() - ratsnestStartedAt;
		}
		this.lastRatsnestCommitSignature = signature;
	}

	/** A deterministic signature of the moved footprints' positions (uuid +
	 *  origin each), used to skip redundant drop-commit ratsnest rebuilds.
	 *  Returns null when a signature can't be computed (caller then always
	 *  rebuilds — correctness never depends on this cache). */
	private ratnestCommitSignature(footprints: Iterable<any>): string | null {
		const parts: string[] = [];
		for (const fp of footprints) {
			const uuid = typeof fp.getUuid === 'function' ? fp.getUuid() : null;
			const origin = typeof fp.getOrigin === 'function' ? fp.getOrigin() : null;
			if (uuid === null || origin === null) return null;
			parts.push(`${ uuid }:${ origin.x }:${ origin.y }:${ origin.rotation }`);
		}
		parts.sort();
		return parts.join('|');
	}

	get isRatsnestVisible(): boolean { return this.ratsnestVisible; }

	beginBoardDragPerformance(): void {
		if (this.activeBoardDragPerformance) {
			return;
		}
		this.activeBoardDragPerformance = {
			startedAt: performance.now(), frames: 0, fastFrames: 0, fallbackFrames: 0,
			staticRebuilds: 0, ratsnestMs: 0, fallbackReasons: {}
		};
	}

	noteBoardDragFrame(fast: boolean): void {
		const metrics = this.activeBoardDragPerformance;
		if (!metrics) {
			return;
		}
		metrics.frames++;
		if (fast) metrics.fastFrames++;
		else {
			metrics.fallbackFrames++;
			const reason = this.lastBoardDragFastRejection ?? 'unknown';
			metrics.fallbackReasons[reason] = (metrics.fallbackReasons[reason] ?? 0) + 1;
		}
	}

	endBoardDragPerformance(): void {
		const metrics = this.activeBoardDragPerformance;
		if (!metrics) {
			return;
		}
		metrics.endedAt = performance.now();
		metrics.durationMs = metrics.endedAt - metrics.startedAt;
		this.lastBoardDragPerformance = { ...metrics };
		console.debug('[KiOnline] board drag performance', this.lastBoardDragPerformance);
		this.activeBoardDragPerformance = null;
	}

	get latestBoardDragPerformance(): Readonly<BoardDragPerformance> | null {
		return this.lastBoardDragPerformance;
	}

	get currentZoneDisplayMode(): ZoneDisplayMode { return this.zoneDisplayMode; }

	get currentBoardGridOrigin(): Readonly<Vec2> { return this.boardGridOrigin; }

	get currentBoardDrillPlaceOrigin(): Readonly<Vec2> { return this.boardDrillPlaceOrigin; }

	setRatsnestVisible(visible: boolean): void {
		this.ratsnestVisible = visible;
		this.scheduleRender();
	}

	/** Switches between Pcbnew's filled-pour and zone-boundary display modes. */
	setZoneDisplayMode(mode: ZoneDisplayMode): void {
		if (this.zoneDisplayMode === mode) {
			return;
		}
		this.zoneDisplayMode = mode;
		// The WebGL static buffer preserves draw calls, so filtering zone
		// geometry requires a rebuild. Canvas2D honors the new mode next frame.
		this.geometryDirty = true;
		this.scheduleRender();
	}

	/** Persists one of Pcbnew's setup-level origins and redraws its marker. */
	setBoardOrigin(kind: 'grid' | 'drill-place', x: number, y: number): boolean {
		if (this.documentType !== 'board' || !this.boardRoot?.rootElement || !Number.isFinite(x) || !Number.isFinite(
			y)) {
			return false;
		}
		this.pushUndoSnapshot(kind === 'grid' ? 'Set Grid Origin' : 'Set Drill/Place File Origin');
		const setup = this.boardRoot.rootElement.findFirstChildByName?.('setup') as any;
		if (!setup) {
			return false;
		}
		const name = kind === 'grid' ? 'grid_origin' : 'aux_axis_origin';
		let origin = setup.findFirstChildByName?.(name) as any;
		if (!origin) {
			origin = new KicadElement();
			origin.name = name;
			setup.addChild(origin);
		}
		origin.attributes = [
			{ value: x, format: 'literal' },
			{ value: y, format: 'literal' }
		];
		if (kind === 'grid') {
			this.boardGridOrigin = new Vec2(x, y);
		}
		else {
			this.boardDrillPlaceOrigin = new Vec2(x, y);
		}
		this.scheduleRender();
		return true;
	}

	/** KiCad omits a zero origin from its board writer; do the same here. */
	resetBoardOrigin(kind: 'grid' | 'drill-place'): boolean {
		if (this.documentType !== 'board' || !this.boardRoot?.rootElement) {
			return false;
		}
		this.pushUndoSnapshot(kind === 'grid' ? 'Reset Grid Origin' : 'Reset Drill/Place File Origin');
		const setup = this.boardRoot.rootElement.findFirstChildByName?.('setup') as any;
		const name = kind === 'grid' ? 'grid_origin' : 'aux_axis_origin';
		const origin = setup?.findFirstChildByName?.(name) as any;
		if (origin) {
			const index = setup.children.indexOf(origin);
			if (index >= 0) {
				setup.children.splice(index, 1);
			}
		}
		if (kind === 'grid') {
			this.boardGridOrigin = new Vec2(0, 0);
		}
		else {
			this.boardDrillPlaceOrigin = new Vec2(0, 0);
		}
		this.scheduleRender();
		return true;
	}

	get currentPadDisplayMode(): ItemDisplayMode { return this.padDisplayMode; }

	get currentViaDisplayMode(): ItemDisplayMode { return this.viaDisplayMode; }

	get currentTrackDisplayMode(): ItemDisplayMode { return this.trackDisplayMode; }

	/** Pcbnew's "Sketch Pads/Vias/Tracks" — same rebuild requirement as
	 *  setZoneDisplayMode above, for the same static-buffer reason. */
	setPadDisplayMode(mode: ItemDisplayMode): void {
		if (this.padDisplayMode === mode) {
			return;
		}
		this.padDisplayMode = mode;
		this.geometryDirty = true;
		this.scheduleRender();
	}

	setViaDisplayMode(mode: ItemDisplayMode): void {
		if (this.viaDisplayMode === mode) {
			return;
		}
		this.viaDisplayMode = mode;
		this.geometryDirty = true;
		this.scheduleRender();
	}

	setTrackDisplayMode(mode: ItemDisplayMode): void {
		if (this.trackDisplayMode === mode) {
			return;
		}
		this.trackDisplayMode = mode;
		this.geometryDirty = true;
		this.scheduleRender();
	}

	get currentCrosshairMode(): CrosshairMode { return this.crosshairMode; }

	setCrosshairMode(mode: CrosshairMode): void {
		if (this.crosshairMode === mode) {
			return;
		}
		this.crosshairMode = mode;
		this.scheduleRender();
	}

	/** Called by the board pointer controller on every mousemove regardless
	 *  of gesture state — the crosshair is redrawn (in whichever style) as
	 *  the pointer moves, since it has no browser-native equivalent for any
	 *  of the 3 modes now (see workingPointWorld's doc comment). */
	updateBoardPointerScreen(pos: Vec2 | null): void {
		this.boardPointerScreen = pos;
		this.scheduleRender();
	}

	/** Sets the crosshair's actual draw position — see workingPointWorld's
	 *  doc comment. Called alongside updateBoardPointerScreen on every
	 *  mousemove; null falls back to the raw (unsnapped) pointer position. */
	setBoardWorkingPoint(point: Vec2 | null): void {
		this.workingPointWorld = point;
		this.scheduleRender();
	}

	/** Matches KiCad's non-warping wheel-zoom branch: the world point under
	 * the cursor remains under that same screen point as the scale changes. */
	zoomByAt(factor: number, screenPos: Vec2): void {
		const anchor = this.screenToWorld(screenPos);
		const next = this.camera.zoom * factor;
		if (!Number.isFinite(next) || next <= 1e-6) {
			return;
		}
		this.camera.zoom = Math.min(next, 1e6);
		const shiftedAnchor = this.screenToWorld(screenPos);
		this.camera.translate(new Vec2(anchor.x - shiftedAnchor.x, anchor.y - shiftedAnchor.y));
		this.scheduleRender();
	}

	/** Center the viewport on a screen position before a centered zoom.
	 * Native KiCad follows this with a platform cursor warp; browsers prohibit
	 * apps from moving the system pointer, so the renderer owns only the
	 * portable camera half of that behavior. */
	centerOnScreenPoint(screenPos: Vec2): void {
		const point = this.screenToWorld(screenPos);
		this.camera.center.set(point.x, point.y);
		this.scheduleRender();
	}

	getRatsnestLines(): readonly BoardRatsnestLine[] {
		return this.ratsnestLines;
	}

	/** Creates one straight copper segment in the board root. Interactive
	 *  routing composes a 45-degree path from several of these KiCad-native
	 *  segment elements; copper junctions are implicit when endpoints touch. */
	addTrackSegment(
		x1: number, y1: number, x2: number, y2: number,
		width: number, layer: string, netId?: number | null, captureUndo = true
	): string | null {
		if (this.documentType !== 'board' || !this.boardRoot?.rootElement
			|| (x1 === x2 && y1 === y2)) {
			return null;
		}
		if (captureUndo) {
			this.pushUndoSnapshot('Route track');
		}
		const segment = new KicadElementSegment();
		segment.setStartEnd(x1, y1, x2, y2);
		segment.setWidth(width);
		segment.setLayer(layer);
		if (netId !== null && netId !== undefined) {
			segment.setNet(netId);
		}
		segment.setUuid();
		this.boardRoot.rootElement.addChild(segment);
		this.commitAstMutation();
		return segment.getUuid() ?? null;
	}

	/** Replaces one existing track segment with a new chain of segments
	 *  covering the exact same electrical path (same net/width/layer,
	 *  original start/end points preserved at the chain's own two ends) —
	 *  the router's shove uses this to reroute a colliding existing track
	 *  around the one just being placed, instead of only flagging a
	 *  clearance violation. `element` must be the live KicadElementSegment
	 *  instance being replaced (carried on a RouterObstacle, which is built
	 *  straight from the current scene's paint items — always current, no
	 *  separate lookup needed). Returns false if the element isn't a live
	 *  child of the board (already removed, wrong document, etc). */
	shoveTrackSegment(element: any, newSegments: { x1: number; y1: number; x2: number; y2: number }[]): boolean {
		if (this.documentType !== 'board' || !this.boardRoot?.rootElement || newSegments.length === 0) {
			return false;
		}
		const parent = this.boardRoot.rootElement;
		const idx = parent.children.indexOf(element);
		if (idx < 0) {
			return false;
		}
		const width = typeof element.getWidth === 'function' ? element.getWidth() : 0.25;
		const layer = typeof element.getLayer === 'function' ? element.getLayer() : 'F.Cu';
		const netId = typeof element.getNetId === 'function' ? element.getNetId() : null;
		const netName = typeof element.getNetName === 'function' ? element.getNetName() : undefined;
		this.pushUndoSnapshot('Shove track');
		const replacements = newSegments
			.filter(seg => seg.x1 !== seg.x2 || seg.y1 !== seg.y2)
			.map(seg => {
				const s = new KicadElementSegment();
				s.setStartEnd(seg.x1, seg.y1, seg.x2, seg.y2);
				s.setWidth(width);
				s.setLayer(layer);
				if (netId !== null && netId !== undefined) {
					s.setNet(netId, netName ?? undefined);
				}
				s.setUuid();
				return s;
			});
		if (replacements.length === 0) {
			return false;
		}
		parent.children.splice(idx, 1, ...replacements);
		this.commitAstMutation();
		return true;
	}

	/** Real KiCad's LINE assembly (PNS_NODE::AssembleLine,
	 *  pns_dragger.cpp:118-152's startDragSegment) — walks outward from a
	 *  clicked track segment in both directions along the SAME connected
	 *  chain (same net, touching endpoints) until hitting a real stopping
	 *  point (a via, a pad, or a >2-way branch — the exact junction rule
	 *  expandBoardConnection's 'junction' tier already encodes), returning
	 *  the ordered chain of segment ids and their as-drawn corner points.
	 *  This is what BoardPointerController's mid-segment drag gesture
	 *  operates on — dragging one segment's body reflows the WHOLE line it
	 *  belongs to, not just that one segment, matching real KiCad. Doesn't
	 *  check lock state itself — same separation of concerns as every other
	 *  session method; callers use isBoardElementLocked per id. Returns null
	 *  for anything that isn't a straight track segment. */
	assembleTrackLine(paintId: string): {
		segmentIds: string[];
		points: Vec2[];
		width: number;
		layer: string;
		netId: number | null
	} | null {
		if (this.documentType !== 'board' || !this.scene) {
			return null;
		}
		const item = this.scene.hitTestItems.find(it => it.id === paintId);
		if (!item || item.kind !== 'track' || item.shape.type !== 'segment') {
			return null;
		}
		// Walk the chain via a track-only adjacency graph — assembleTrackLine
		// only needs track-to-track contact to find the clicked segment's chain,
		// so it must NOT trigger the full buildCopperGraph (which also does the
		// board-wide pad/via/zone connectivity and is the dominant cost on a
		// zoned board, e.g. the 10s mouse-down in the trace). KiCad walks a
		// track chain from prebuilt topology; this scoped builder gives the
		// same result (a chain walk depends only on track contacts).
		const graph = buildTrackChainGraph(this.scene);
		const ownNodeIndices = graph.nodes
			.map((node, index) => ({ node, index }))
			.filter(({ node }) => node.itemId === paintId)
			.map(({ index }) => index);
		if (ownNodeIndices.length !== 2) {
			return null;
		}
		const [nodeAIndex, nodeBIndex] = ownNodeIndices as [number, number];

		const fromA = this.walkTrackChainOutward(graph, nodeAIndex, paintId);
		const fromB = this.walkTrackChainOutward(graph, nodeBIndex, paintId);
		return {
			segmentIds: [...fromA.segmentIds.reverse(), paintId, ...fromB.segmentIds],
			points: [
				...fromA.points.reverse(), graph.nodes[nodeAIndex]!.point, graph.nodes[nodeBIndex]!.point,
				...fromB.points
			],
			width: item.shape.width,
			layer: item.layer,
			netId: item.netId ?? null
		};
	}

	/** A node is a stop for walkTrackChainOutward's linear walk once it's
	 *  not a track at all (a pad/via — real KiCad's own AssembleLine
	 *  boundary) or is a >2-way branch point (more than one OTHER track
	 *  touching it besides the one just arrived from). */
	private isTrackChainStop(graph: CopperGraph, nodeIndex: number): boolean {
		const node = graph.nodes[nodeIndex]!;
		if (node.itemKind !== 'track') {
			return true;
		}
		return graph.adjacent(nodeIndex).filter(other => graph.nodes[other]!.itemKind === 'track').length > 2;
	}

	private currentCopperGraph(): CopperGraph {
		if (!this.scene) {
			throw new Error('No board scene is loaded.');
		}
		if (!this.copperGraphCache || this.copperGraphCache.scene !== this.scene) {
			this.copperGraphCache = { scene: this.scene, graph: buildCopperGraph(this.scene) };
		}
		return this.copperGraphCache.graph;
	}

	/** Follows a connected straight-track chain one hop at a time from
	 *  `startIndex`, away from the segment identified by `arrivedFromId` —
	 *  every "touching-point" union recorded during buildCopperGraph is a
	 *  single physical hop, so a plain 2-way continuation always has exactly
	 *  one qualifying next node; isTrackChainStop's junction/via/pad check
	 *  is what keeps this a linear walk instead of a general graph
	 *  traversal. Shared by assembleTrackLine (mid-segment drag, walks both
	 *  directions from a clicked segment) and viaDragFanout (walks away from
	 *  a via, one direction per connected track). */
	private walkTrackChainOutward(
		graph: CopperGraph, startIndex: number, arrivedFromId: string
	): { segmentIds: string[]; points: Vec2[] } {
		const segmentIds: string[] = [];
		const points: Vec2[] = [];
		let current = startIndex;
		let cameFromId = arrivedFromId;
		let guard = 0;
		while (guard++ < 10000) {
			if (this.isTrackChainStop(graph, current)) {
				break;
			}
			const nextNodeIndex = graph.adjacent(current).find(candidate => {
				const candidateNode = graph.nodes[candidate]!;
				return candidateNode.itemKind === 'track' && candidateNode.itemId !== cameFromId;
			});
			if (nextNodeIndex === undefined) {
				break;
			}
			const nextNode = graph.nodes[nextNodeIndex]!;
			const otherEndIndex = graph.adjacent(nextNodeIndex)
				.find(candidate => graph.nodes[candidate]!.itemId === nextNode.itemId);
			if (otherEndIndex === undefined) {
				break;
			}
			segmentIds.push(nextNode.itemId);
			points.push(graph.nodes[otherEndIndex]!.point);
			current = otherEndIndex;
			cameFromId = nextNode.itemId;
		}
		return { segmentIds, points };
	}

	/** Commits a dragged track line — replaces every one of `oldSegmentIds`'
	 *  live elements with fresh segments along consecutive `newPoints` pairs
	 *  (N old segments in, M new segments out; M is whatever
	 *  dragSegment45/the drag's obstacle handling produced, not necessarily
	 *  N). Generalizes shoveTrackSegment's splice-replace shape above to
	 *  multiple old elements — same width/layer/net applied to every new
	 *  segment (a dragged line is by construction all one net/layer/width;
	 *  assembleTrackLine only ever walks a single such chain), one
	 *  pushUndoSnapshot + commitAstMutation. Returns false if any id isn't a
	 *  live child of the board or the new point chain is degenerate.
	 *
	 *  Resolves oldSegmentIds against the AST (parent.children) by uuid, NOT
	 *  against this.scene.hitTestItems: beginTrackDragPreview (see its doc
	 *  comment) deliberately removes the assembled line's segments from that
	 *  same hitTestItems list for the whole drag, so a scene-based lookup
	 *  here would always find zero of them and silently no-op the commit —
	 *  every drag would compute the right shape and then revert, since
	 *  endTrackDragPreview's scene restore is deferred to the next render()
	 *  tick, which never runs before this synchronous call. This was an
	 *  actual shipped bug, root-caused against a real user board. */
	dragTrackLine(
		oldSegmentIds: string[], newPoints: Vec2[], width: number, layer: string, netId: number | null): boolean {
		if (this.documentType !== 'board' || !this.boardRoot?.rootElement || oldSegmentIds.length === 0
			|| newPoints.length < 2) {
			return false;
		}
		const parent = this.boardRoot.rootElement;
		const wanted = new Set(oldSegmentIds);
		const oldElements: any[] = parent.children.filter((child: any) => {
			const uuid = child instanceof KicadElementSegment ? child.getUuid() : undefined;
			return uuid !== undefined && wanted.has(uuid);
		});
		if (oldElements.length !== oldSegmentIds.length) {
			return false;
		}
		const indices = oldElements.map(element => parent.children.indexOf(element)).filter(index => index >= 0);
		if (indices.length !== oldElements.length) {
			return false;
		}
		const firstIndex = Math.min(...indices);
		this.pushUndoSnapshot('Drag track');
		for (const element of oldElements) {
			const idx = parent.children.indexOf(element);
			if (idx >= 0) {
				parent.children.splice(idx, 1);
			}
		}
		const replacements: any[] = [];
		for (let i = 0; i < newPoints.length - 1; i++) {
			const a = newPoints[i]!, b = newPoints[i + 1]!;
			if (a.x === b.x && a.y === b.y) {
				continue;
			}
			const segment = new KicadElementSegment();
			segment.setStartEnd(a.x, a.y, b.x, b.y);
			segment.setWidth(width);
			segment.setLayer(layer);
			if (netId !== null && netId !== undefined) {
				segment.setNet(netId);
			}
			segment.setUuid();
			replacements.push(segment);
		}
		if (replacements.length === 0) {
			return false;
		}
		const insertAt = Math.min(firstIndex, parent.children.length);
		parent.children.splice(insertAt, 0, ...replacements);
		if (this.scene) {
			this.committedTrackOverlay.push(...this.painter.updateTrackItems(this.scene, this.boardRoot, wanted, replacements));
			this.hiddenTrackDragIds.clear();
			this.copperGraphCache = null;
			this.selectedIds = new Set(replacements.map(segment => segment.getUuid()).filter((id): id is string => !!id));
			this.scheduleRender();
		}
		else {
			this.commitAstMutation();
		}
		return true;
	}

	/** Post-route cleanup — a from-scratch analog of real KiCad's "Cleanup
	 *  Tracks and Vias" (pcbnew's TRACKS_CLEANER): removes zero-length
	 *  segments, then repeatedly merges any two straight track segments that
	 *  meet at a point touched by exactly those two (same net/layer/width,
	 *  and collinear within a small epsilon) into one longer segment. A
	 *  degree-2 point with matching width/layer/net is always safe to
	 *  collapse regardless of whether a pad/via happens to sit exactly on
	 *  it — the merged segment is still a straight line through that same
	 *  coordinate, so any copper touching the point stays connected; this
	 *  only removes a redundant polyline vertex, never a component. Runs as
	 *  a single undo-able command (called from the Tools menu), not a
	 *  per-frame drag helper — the O(segments) rescans per pass are fine at
	 *  that call frequency. */
	cleanupTracks(): { merged: number; removed: number } {
		if (this.documentType !== 'board' || !this.boardRoot?.rootElement) {
			return { merged: 0, removed: 0 };
		}
		const root = this.boardRoot.rootElement;
		const allSegments = root.findChildrenByClass(KicadElementSegment) as KicadElementSegment[];
		const zeroLength = allSegments.filter(seg => {
			const { start, end } = seg.getStartEnd();
			return start.x === end.x && start.y === end.y;
		});
		let survivors = allSegments.filter(seg => !zeroLength.includes(seg));
		let mergedCount = 0;
		const EPS = 1e-6;
		const pointKey = (layer: string, netId: number | null, x: number, y: number) =>
			`${ layer }|${ netId }|${ x.toFixed(5) }|${ y.toFixed(5) }`;
		let changed = true;
		while (changed) {
			changed = false;
			const touching = new Map<string, KicadElementSegment[]>();
			for (const seg of survivors) {
				const { start, end } = seg.getStartEnd();
				const layer = seg.getLayer();
				const netId = seg.getNetId();
				for (const p of [start, end]) {
					const key = pointKey(layer, netId, p.x, p.y);
					const arr = touching.get(key);
					if (arr) {
						arr.push(seg);
					}
					else {
						touching.set(key, [seg]);
					}
				}
			}
			for (const [, pair] of touching) {
				if (pair.length !== 2 || pair[0] === pair[1]) {
					continue;
				}
				const [a, b] = pair as [KicadElementSegment, KicadElementSegment];
				if (a.getWidth() !== b.getWidth() || a.getLayer() !== b.getLayer() || a.getNetId() !== b.getNetId()) {
					continue;
				}
				const A = a.getStartEnd();
				const B = b.getStartEnd();
				// The shared point is whichever endpoint pairing coincides;
				// the merge keeps the two FAR endpoints (one from each
				// segment) as the new combined segment's ends.
				let sharedA: { x: number; y: number }, farA: { x: number; y: number };
				let sharedB: { x: number; y: number }, farB: { x: number; y: number };
				if (Math.hypot(A.start.x - B.start.x, A.start.y - B.start.y) < EPS) {
					sharedA = A.start;
					farA = A.end;
					sharedB = B.start;
					farB = B.end;
				}
				else if (Math.hypot(A.start.x - B.end.x, A.start.y - B.end.y) < EPS) {
					sharedA = A.start;
					farA = A.end;
					sharedB = B.end;
					farB = B.start;
				}
				else if (Math.hypot(A.end.x - B.start.x, A.end.y - B.start.y) < EPS) {
					sharedA = A.end;
					farA = A.start;
					sharedB = B.start;
					farB = B.end;
				}
				else if (Math.hypot(A.end.x - B.end.x, A.end.y - B.end.y) < EPS) {
					sharedA = A.end;
					farA = A.start;
					sharedB = B.end;
					farB = B.start;
				}
				else {
					continue;
				}
				void sharedB;
				// Collinearity: cross product of (shared-farA) and (shared-farB)
				// must be ~0 — the two segments point the same/opposite way
				// through the shared point, not at an angle (a real corner).
				const v1x = sharedA.x - farA.x, v1y = sharedA.y - farA.y;
				const v2x = farB.x - sharedA.x, v2y = farB.y - sharedA.y;
				const cross = v1x * v2y - v1y * v2x;
				if (Math.abs(cross) > EPS) {
					continue;
				}
				a.setStartEnd(farA.x, farA.y, farB.x, farB.y);
				survivors = survivors.filter(s => s !== b);
				mergedCount++;
				changed = true;
				break;
			}
		}
		if (zeroLength.length === 0 && mergedCount === 0) {
			return { merged: 0, removed: 0 };
		}
		this.pushUndoSnapshot('Cleanup tracks and vias');
		for (const seg of allSegments) {
			if (!survivors.includes(seg)) {
				const idx = root.children.indexOf(seg);
				if (idx >= 0) {
					root.children.splice(idx, 1);
				}
			}
		}
		this.commitAstMutation();
		return { merged: mergedCount, removed: zeroLength.length };
	}

	/** Computes (without mutating anything) the connected-line fanout for a
	 *  via-drag gesture — mirrors real KiCad's DRAGGER::Start
	 *  (findViaFanoutByHandle, pns_dragger.cpp) computing the fanout ONCE at
	 *  drag-start and reusing it for the whole gesture, rather than
	 *  re-deriving it every mouse move: an earlier version of this method
	 *  re-walked buildCopperGraph on every single mousemove call and used
	 *  "the other end of whatever segment currently touches the via" as the
	 *  anchor — correct on the very first call, but on every call after
	 *  that, the "current" near-via segment IS the elbow this same method
	 *  created a moment ago, so the anchor kept sliding forward to that
	 *  elbow's own corner instead of staying at the track's true fixed far
	 *  point. A real drag fires many mouse-move events, so that compounded
	 *  into a trail of dozens of ever-shorter stray segments (reported as
	 *  "makes some mess"). Calling this ONCE at gesture start and reusing
	 *  the SAME fanout for every live-preview frame (via
	 *  BoardPointerController's 'via' gesture, mirroring 'track-body''s
	 *  assembleTrackLine/dragSegment45 split) fixes that.
	 *
	 *  For each track connected to the via (per bridged copper layer),
	 *  walks the WHOLE assembled line out to its real far anchor (a pad,
	 *  junction, or another via — walkTrackChainOutward's stop rule,
	 *  matching real KiCad's own AssembleLine boundary) rather than just the
	 *  one segment immediately touching the via. This is what dragViaChain
	 *  (PnsDragger.ts, the port of dragCornerInternal) needs: its backward
	 *  search can only absorb a trailing segment that would otherwise
	 *  zigzag if that segment is actually IN the chain handed to it — with
	 *  only the near segment available (this method's first version), the
	 *  search space was always exactly one segment wide, which is what
	 *  produced the reported "weird C shape" the real router doesn't. A
	 *  fix's whole segment chain is skipped (not partially dragged) if ANY
	 *  segment in it is locked — a via with an unusual fanout shouldn't
	 *  half-drag a locked track by touching just its unlocked near end.
	 *  Returns null for a paintId that isn't a live via on the current
	 *  board. */
	viaDragFanout(paintId: string): { fixes: ViaDragFix[]; viaSize: number } | null {
		if (this.documentType !== 'board' || !this.boardRoot?.rootElement || !this.scene) {
			return null;
		}
		this.rebuildBoardSceneIfPending();
		const viaItem = this.scene.hitTestItems.find(it => it.id === paintId);
		if (!viaItem?.element || !(viaItem.element instanceof KicadElementVia) || viaItem.shape.type !== 'circle') {
			return null;
		}
		const viaSize = viaItem.shape.r * 2;
		const graph = this.currentCopperGraph();
		const viaNodeIndices = graph.nodes
			.map((node, index) => ({ node, index }))
			.filter(({ node }) => node.itemId === paintId && node.itemKind === 'via')
			.map(({ index }) => index);

		const fixes: ViaDragFix[] = [];
		// A through via's several per-layer nodes could each separately
		// touch a track on their own layer — dedupe by the track's own
		// paint id so a track never gets queued for two conflicting fixes.
		const seenTrackIds = new Set<string>();
		for (const viaNodeIndex of viaNodeIndices) {
			const viaPoint = graph.nodes[viaNodeIndex]!.point;
			for (const neighborIndex of graph.adjacent(viaNodeIndex)) {
				const neighbor = graph.nodes[neighborIndex]!;
				if (neighbor.itemKind !== 'track' || seenTrackIds.has(neighbor.itemId)) {
					continue;
				}
				seenTrackIds.add(neighbor.itemId);
				const otherEndIndex = graph.adjacent(neighborIndex)
					.find(candidate => graph.nodes[candidate]!.itemId === neighbor.itemId);
				if (otherEndIndex === undefined) {
					continue;
				}
				const segItem = this.scene.hitTestItems.find(it => it.id === neighbor.itemId);
				if (!segItem || segItem.shape.type !== 'segment') {
					continue;
				}
				const walked = this.walkTrackChainOutward(graph, otherEndIndex, neighbor.itemId);
				// Near-to-far order (segment touching the via first).
				const segmentIds = [neighbor.itemId, ...walked.segmentIds];
				if (segmentIds.some(id => this.isBoardElementLocked(id))) {
					continue;
				}
				const points = [graph.nodes[otherEndIndex]!.point, ...walked.points];
				fixes.push({
					// Reversed to far-to-near/far-anchor-first — the order
					// dragViaChain and its upstream original both expect.
					segmentIds: [...segmentIds].reverse(),
					originPoints: [...points].reverse().concat([viaPoint]),
					width: segItem.shape.width,
					layer: segItem.layer,
					netId: segItem.netId ?? null
				});
			}
		}
		return { fixes, viaSize };
	}

	/** Commits a via drag once, at mouseup — replaces each fix's WHOLE
	 *  segment chain (resolved by uuid straight from the AST, not
	 *  this.scene.hitTestItems: the gesture that leads here hid these exact
	 *  segments out of the scene for the whole drag via
	 *  beginTrackDragPreview, and endTrackDragPreview's restore is itself
	 *  deferred to the next render(), so at the moment onMouseUp calls this
	 *  the scene still doesn't have them back — same reasoning as
	 *  dragTrackLine's identical AST-not-scene lookup) with its final point
	 *  chain, moves the via, single undo snapshot. `chain` is whatever
	 *  BoardPointerController's live preview last computed via
	 *  dragViaChain(fix.originPoints, cursor, cornerMode) — committing the
	 *  exact last-previewed geometry rather than recomputing it here keeps
	 *  this a plain "make it permanent" step, the same WYSIWYG contract
	 *  dragTrackLine's commitPoints parameter has. Multiple old segments can
	 *  collapse into however many new ones `chain` produced (mirrors
	 *  dragTrackLine's own N-old-to-M-new splice), all inserted at the
	 *  position of the chain's nearest-to-far-anchor old segment. */
	commitViaDrag(
		paintId: string,
		fixes: { segmentIds: string[]; chain: Vec2[]; width: number; layer: string; netId: number | null }[],
		x: number, y: number
	): boolean {
		if (this.documentType !== 'board' || !this.boardRoot?.rootElement) {
			return false;
		}
		const parent = this.boardRoot.rootElement;
		const viaElement = parent.children.find((child: any) =>
			child instanceof KicadElementVia && child.getUuid() === paintId);
		if (!viaElement) {
			return false;
		}
		this.pushUndoSnapshot('Move via');
		for (const fix of fixes) {
			this.applyFixChain(parent, fix, fix.chain, fix.width, fix.layer, fix.netId);
		}
		viaElement.setOrigin(x, y);
		this.commitAstMutation();
		return true;
	}

	/** Shared N-old-segments-to-M-new-segments splice, resolved by uuid
	 *  straight from the AST (not this.scene.hitTestItems: the gesture that
	 *  leads here hid these exact segments out of the scene for the whole
	 *  drag via beginTrackDragPreview, and endTrackDragPreview's restore is
	 *  itself deferred to the next render(), so at commit time the scene
	 *  still doesn't have them back — same reasoning as dragTrackLine's own
	 *  AST-not-scene lookup). Used by both commitViaDrag (one call per
	 *  fanout fix, via element moved separately after) and
	 *  commitTrackCornerDrag (same shape, no via involved) — factored out
	 *  once the two calls turned out identical. No-ops (leaves the AST
	 *  untouched) if `fix.segmentIds` doesn't fully resolve to live
	 *  elements. Caller owns pushUndoSnapshot/commitAstMutation. */
	private applyFixChain(
		parent: any,
		fix: { segmentIds: string[] },
		chain: Vec2[], width: number, layer: string, netId: number | null
	): void {
		{
			const wanted = new Set(fix.segmentIds);
			const oldElements: any[] = parent.children.filter((child: any) => {
				const uuid = child instanceof KicadElementSegment ? child.getUuid() : undefined;
				return uuid !== undefined && wanted.has(uuid);
			});
			if (oldElements.length !== fix.segmentIds.length) {
				return;
			}
			const firstIndex = Math.min(...oldElements.map(element => parent.children.indexOf(element)));
			for (const element of oldElements) {
				const idx = parent.children.indexOf(element);
				if (idx >= 0) {
					parent.children.splice(idx, 1);
				}
			}
			const replacements: any[] = [];
			for (let i = 0; i < chain.length - 1; i++) {
				const a = chain[i]!, b = chain[i + 1]!;
				if (a.x === b.x && a.y === b.y) {
					continue;
				}
				const segment = new KicadElementSegment();
				segment.setStartEnd(a.x, a.y, b.x, b.y);
				segment.setWidth(width);
				segment.setLayer(layer);
				if (netId !== null && netId !== undefined) {
					segment.setNet(netId);
				}
				segment.setUuid();
				replacements.push(segment);
			}
			if (replacements.length > 0) {
				const insertAt = Math.min(firstIndex, parent.children.length);
				parent.children.splice(insertAt, 0, ...replacements);
			}
		}
	}

	/** Computes (without mutating anything) the fanout for dragging a
	 *  single track corner (an endpoint reported by trackEndpointNear) —
	 *  real KiCad's DragCorner (LINE::DragCorner, pns_line.cpp) always
	 *  operates on the WHOLE assembled line the clicked corner belongs to,
	 *  the same AssembleLine boundary assembleTrackLine/viaDragFanout both
	 *  already use, not just the one segment that happens to have been
	 *  clicked — a previous, simpler version of this drag
	 *  (moveTrackEndpointByPaintId) just overwrote the raw coordinate with
	 *  no 45°/90° constraint and no elbow reflow at all, which is exactly
	 *  what produced the reported "after a couple minutes of dragging wires
	 *  I end up with some monstrosity": real KiCad never lets a drag leave
	 *  the routing grid, no matter which corner you grab.
	 *
	 *  The dragged corner can be either a true dangling end (nothing else
	 *  touches it — the common "extend this wire" case) or a junction where
	 *  OTHER tracks also meet (a mid-board T/corner) — real KiCad's own
	 *  dragCorner45 handles both uniformly by treating the drag point as the
	 *  shared endpoint of however many connected lines happen to touch it,
	 *  reflowing each one independently toward the same new position (see
	 *  its own `aIndex` middle-vs-end branches). This mirrors that: one
	 *  ViaDragFix per connected line touching the drag point (always
	 *  including the clicked segment's own line, walking away from the
	 *  clicked corner through it), each walked out to its own real far
	 *  anchor via walkTrackChainOutward exactly like viaDragFanout's per-
	 *  layer fixes — there's just no via at the near end here, only a bare
	 *  point. Fixes touching a locked segment are dropped (not refused
	 *  wholesale — matches viaDragFanout's own lock simplification).
	 *  Returns null if the corner isn't a live track endpoint, or every
	 *  fix ended up locked. */
	trackCornerDragFanout(paintId: string, endpoint: 'start' | 'end'): { fixes: ViaDragFix[]; dragPoint: Vec2 } | null {
		if (this.documentType !== 'board' || !this.scene) {
			return null;
		}
		this.rebuildBoardSceneIfPending();
		const item = this.scene.hitTestItems.find(it => it.id === paintId);
		if (!item || item.kind !== 'track' || item.shape.type !== 'segment') {
			return null;
		}
		const dragPoint = endpoint === 'start'
			? new Vec2(item.shape.x1, item.shape.y1)
			: new Vec2(item.shape.x2, item.shape.y2);

		const graph = this.currentCopperGraph();
		const ownNodeIndices = graph.nodes
			.map((node, index) => ({ node, index }))
			.filter(({ node }) => node.itemId === paintId)
			.map(({ index }) => index);
		if (ownNodeIndices.length !== 2) {
			return null;
		}
		const [nodeA, nodeB] = ownNodeIndices as [number, number];
		const distA = Math.hypot(graph.nodes[nodeA]!.point.x - dragPoint.x, graph.nodes[nodeA]!.point.y - dragPoint.y);
		const distB = Math.hypot(graph.nodes[nodeB]!.point.x - dragPoint.x, graph.nodes[nodeB]!.point.y - dragPoint.y);
		const nodeAtDragPoint = distA <= distB ? nodeA : nodeB;
		const ownOtherEnd = distA <= distB ? nodeB : nodeA;

		const fixes: ViaDragFix[] = [];
		const seenTrackIds = new Set<string>([paintId]);

		// The clicked segment's own line: walk away from the drag point,
		// through the segment itself, out to its real far anchor.
		{
			const walked = this.walkTrackChainOutward(graph, ownOtherEnd, paintId);
			const nearToFarIds = [paintId, ...walked.segmentIds];
			const nearToFarPoints = [graph.nodes[ownOtherEnd]!.point, ...walked.points];
			fixes.push({
				segmentIds: [...nearToFarIds].reverse(),
				originPoints: [...nearToFarPoints].reverse().concat([dragPoint]),
				width: item.shape.width,
				layer: item.layer,
				netId: item.netId ?? null
			});
		}

		// Any OTHER track(s) also touching the drag point — a junction, not
		// a true dangling end.
		for (const neighborIndex of graph.adjacent(nodeAtDragPoint)) {
			const neighbor = graph.nodes[neighborIndex]!;
			if (neighbor.itemKind !== 'track' || seenTrackIds.has(neighbor.itemId)) {
				continue;
			}
			seenTrackIds.add(neighbor.itemId);
			const otherEndIndex = graph.adjacent(neighborIndex)
				.find(candidate => graph.nodes[candidate]!.itemId === neighbor.itemId);
			if (otherEndIndex === undefined) {
				continue;
			}
			const segItem = this.scene.hitTestItems.find(it => it.id === neighbor.itemId);
			if (!segItem || segItem.shape.type !== 'segment') {
				continue;
			}
			const walked = this.walkTrackChainOutward(graph, otherEndIndex, neighbor.itemId);
			const nearToFarIds = [neighbor.itemId, ...walked.segmentIds];
			const nearToFarPoints = [graph.nodes[otherEndIndex]!.point, ...walked.points];
			fixes.push({
				segmentIds: [...nearToFarIds].reverse(),
				originPoints: [...nearToFarPoints].reverse().concat([dragPoint]),
				width: segItem.shape.width,
				layer: segItem.layer,
				netId: segItem.netId ?? null
			});
		}

		const unlockedFixes = fixes.filter(fix => !fix.segmentIds.some(id => this.isBoardElementLocked(id)));
		if (unlockedFixes.length === 0) {
			return null;
		}
		return { fixes: unlockedFixes, dragPoint };
	}

	/** Commits a track-corner drag once, at mouseup — same WYSIWYG
	 *  "replace with whatever the live preview last computed" contract as
	 *  commitViaDrag, just with no via to move at the end (the drag point
	 *  isn't its own persisted element — it's just wherever every fix's
	 *  chain happens to converge). */
	commitTrackCornerDrag(
		fixes: { segmentIds: string[]; chain: Vec2[]; width: number; layer: string; netId: number | null }[]
	): boolean {
		if (this.documentType !== 'board' || !this.boardRoot?.rootElement || fixes.length === 0) {
			return false;
		}
		const parent = this.boardRoot.rootElement;
		this.pushUndoSnapshot('Drag track');
		for (const fix of fixes) {
			this.applyFixChain(parent, fix, fix.chain, fix.width, fix.layer, fix.netId);
		}
		this.commitAstMutation();
		return true;
	}

	/** Creates a through via spanning the supplied copper-layer pair. */
	addVia(
		x: number, y: number, size: number, drill: number,
		layers: readonly string[], netId?: number | null, captureUndo = true
	): string | null {
		if (this.documentType !== 'board' || !this.boardRoot?.rootElement || layers.length < 2) {
			return null;
		}
		if (captureUndo) {
			this.pushUndoSnapshot('Place via');
		}
		const via = new KicadElementVia();
		via.setOrigin(x, y);
		via.setSize(size);
		via.setDrill(drill);
		for (const layer of layers) {
			via.addLayer(layer);
		}
		if (netId !== null && netId !== undefined) {
			via.setNet(netId);
		}
		via.setUuid();
		this.boardRoot.rootElement.addChild(via);
		this.commitAstMutation();
		return via.getUuid() ?? null;
	}

	/** Pcbnew's default board-graphic width (board_design_settings.h's
	 * DEFAULT_LINE_WIDTH) is 0.10 mm.  These helpers intentionally construct
	 * the board-native `gr_*` records rather than reusing schematic graphics. */
	addBoardGraphicLine(
		x1: number, y1: number, x2: number, y2: number, layer: string, strokeWidth = 0.1): string | null {
		if (!this.canAddBoardGraphic() || (x1 === x2 && y1 === y2)) {
			return null;
		}
		this.pushUndoSnapshot('Draw line');
		const line = new KicadElementGrLine();
		line.setStartEnd(x1, y1, x2, y2);
		line.setStroke(strokeWidth, 'default');
		line.setLayer(layer);
		line.setUuid();
		this.boardRoot!.rootElement.addChild(line);
		this.commitAstMutation();
		return line.getUuid() ?? null;
	}

	addBoardGraphicRect(
		x1: number, y1: number, x2: number, y2: number, layer: string, strokeWidth = 0.1): string | null {
		if (!this.canAddBoardGraphic() || (x1 === x2 && y1 === y2)) {
			return null;
		}
		this.pushUndoSnapshot('Draw rectangle');
		const rect = new KicadElementGrRect();
		rect.setStartEnd(x1, y1, x2, y2);
		rect.setStroke(strokeWidth, 'default');
		rect.setLayer(layer);
		rect.setUuid();
		this.boardRoot!.rootElement.addChild(rect);
		this.commitAstMutation();
		return rect.getUuid() ?? null;
	}

	addBoardGraphicCircle(cx: number, cy: number, radius: number, layer: string, strokeWidth = 0.1): string | null {
		if (!this.canAddBoardGraphic() || radius <= 0) {
			return null;
		}
		this.pushUndoSnapshot('Draw circle');
		const circle = new KicadElementGrCircle();
		circle.setCenter(cx, cy);
		circle.setEnd(cx + radius, cy);
		circle.setStroke(strokeWidth, 'default');
		circle.setLayer(layer);
		circle.setUuid();
		this.boardRoot!.rootElement.addChild(circle);
		this.commitAstMutation();
		return circle.getUuid() ?? null;
	}

	addBoardGraphicArc(
		sx: number, sy: number, mx: number, my: number, ex: number, ey: number, layer: string,
		strokeWidth = 0.1
	): string | null {
		if (!this.canAddBoardGraphic() || (sx === ex && sy === ey)) {
			return null;
		}
		this.pushUndoSnapshot('Draw arc');
		const arc = new KicadElementGrArc();
		arc.setStartMidEnd(sx, sy, mx, my, ex, ey);
		arc.setStroke(strokeWidth, 'default');
		arc.setLayer(layer);
		arc.setUuid();
		this.boardRoot!.rootElement.addChild(arc);
		this.commitAstMutation();
		return arc.getUuid() ?? null;
	}

	addBoardGraphicBezier(
		points: readonly { x: number; y: number }[], layer: string, strokeWidth = 0.1): string | null {
		if (!this.canAddBoardGraphic() || points.length !== 4) {
			return null;
		}
		this.pushUndoSnapshot('Draw Bezier');
		const curve = new KicadElementGrCurve();
		curve.setPoints(points.map(point => ({ x: point.x, y: point.y })));
		curve.setStroke(strokeWidth, 'default');
		curve.setLayer(layer);
		curve.setUuid();
		this.boardRoot!.rootElement.addChild(curve);
		this.commitAstMutation();
		return curve.getUuid() ?? null;
	}

	/** Pcbnew's board defaults from board_design_settings.h: 1.0 mm text with
	 * 0.15 mm text stroke.  It anchors newly placed text left/bottom and mirrors
	 * it when placed on a back layer. */
	addBoardGraphicText(x: number, y: number, value: string, layer: string): string | null {
		if (!this.canAddBoardGraphic() || !value.trim()) {
			return null;
		}
		this.pushUndoSnapshot('Draw text');
		const text = new KicadElementGrText(value);
		text.setOrigin(x, y, 0);
		text.setLayer(layer);
		text.setFont(1, 1, false, false, 0.15);
		text.setJustify('left', 'bottom', layer.startsWith('B.'));
		text.setUuid();
		this.boardRoot!.rootElement.addChild(text);
		this.commitAstMutation();
		return text.getUuid() ?? null;
	}

	/** Native Pcbnew `gr_text_box`: the default legacy margin is
	 * stroke/2 + text-height*0.75 = 0.825 mm for the default board style.
	 * A text box is border-enabled by default and uses the ordinary 0.10 mm
	 * graphic stroke while its text itself uses the 0.15 mm text stroke. */
	addBoardGraphicTextBox(
		x1: number, y1: number, x2: number, y2: number, value: string, layer: string): string | null {
		if (!this.canAddBoardGraphic() || !value.trim() || x1 === x2 || y1 === y2) {
			return null;
		}
		this.pushUndoSnapshot('Draw text box');
		const textBox = new KicadElementGrTextBox(value);
		textBox.setStartEnd(Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2));
		textBox.setSimpleChild('margins', 0.825, 'numeric').setAttribute({ value: 0.825, format: 'numeric' }, 1);
		const margins = textBox.findFirstChildByName('margins')!;
		margins.setAttribute({ value: 0.825, format: 'numeric' }, 2);
		margins.setAttribute({ value: 0.825, format: 'numeric' }, 3);
		textBox.setLayer(layer);
		textBox.setFont(1, 1, false, false, 0.15);
		textBox.setJustify('left', 'middle', layer.startsWith('B.'));
		textBox.setSimpleChild('border', true, 'boolean');
		textBox.setSimpleChild('knockout', false, 'boolean');
		textBox.setStroke(0.1, 'default');
		textBox.setUuid();
		this.boardRoot!.rootElement.addChild(textBox);
		this.commitAstMutation();
		return textBox.getUuid() ?? null;
	}

	private canAddBoardGraphic(): boolean {
		return this.documentType === 'board' && !!this.boardRoot?.rootElement;
	}

	/** Embed a raster image as a board-level `image` record on the active
	 * layer.  KiCad stores the same binary payload shape as schematic images,
	 * with the PCB layer providing its visibility and rendering color context. */
	addBoardGraphicImage(
		x: number, y: number, data: string, mimeType: string, layer: string, scale = 1): string | null {
		if (!this.canAddBoardGraphic() || !data || !mimeType.startsWith('image/')) {
			return null;
		}
		this.pushUndoSnapshot('Place image');
		const image = new KicadElementImage();
		image.setOrigin(x, y);
		image.setLayer(layer);
		image.setScale(Number.isFinite(scale) && scale > 0 ? scale : 1);
		image.setUuid();
		const imageData = new KicadElementData();
		imageData.data = data;
		image.addChild(imageData);
		this.boardRoot!.rootElement.addChild(image);
		this.commitAstMutation();
		return image.getUuid() ?? null;
	}

	/** Creates a native Pcbnew `(barcode ...)` semantic record. Its modules are
	 * deliberately not serialized: Zint regenerates them from these fields. */
	addBoardBarcode(
		x: number, y: number, data: {
			text: string;
			type: 'code39' | 'code128' | 'datamatrix' | 'qr' | 'microqr';
			errorCorrection: 'L' | 'M' | 'Q' | 'H';
			showText: boolean;
			textHeightMm: number;
			widthMm: number;
			heightMm: number;
			locked: boolean;
			layer: string;
			knockout: boolean;
			marginXmm: number;
			marginYmm: number;
			orientation: number;
		}
	): string | null {
		if (!this.canAddBoardGraphic() || !data.text.trim()) {
			return null;
		}
		this.pushUndoSnapshot('Place barcode');
		const barcode = new KicadElementBarcode();
		barcode.setOrigin(x, y, data.orientation);
		barcode.setLayer(data.layer);
		barcode.setSize(Math.max(0.01, data.widthMm), Math.max(0.01, data.heightMm));
		barcode.setBarcodeText(data.text);
		barcode.setBarcodeType(data.type);
		if (data.type === 'qr' || data.type === 'microqr') {
			barcode.setErrorCorrection(data.errorCorrection);
		}
		barcode.setTextHidden(!data.showText);
		barcode.setTextHeight(Math.max(0.01, data.textHeightMm));
		barcode.setKnockout(data.knockout);
		if (data.knockout) {
			barcode.setMargins(Math.max(0, data.marginXmm), Math.max(0, data.marginYmm));
		}
		barcode.setLocked(data.locked);
		barcode.setUuid();
		this.boardRoot!.rootElement.addChild(barcode);
		this.commitAstMutation();
		return barcode.getUuid() ?? null;
	}

	/** Creates the two regular linear dimension records Pcbnew uses. `height`
	 * is the signed offset of the rendered dimension line from the measured
	 * points, rather than a third point in the file format. */
	addBoardDimension(
		type: 'aligned' | 'orthogonal', first: { x: number; y: number }, second: { x: number; y: number },
		placement: { x: number; y: number }, layer: string
	): string | null {
		if (!this.canAddBoardGraphic() || (first.x === second.x && first.y === second.y)) {
			return null;
		}
		const dx = second.x - first.x;
		const dy = second.y - first.y;
		const orientation = Math.abs(dx) >= Math.abs(dy) ? 0 : 1;
		const distance = Math.hypot(dx, dy);
		const height = type === 'orthogonal'
			? (orientation === 0 ? placement.y - first.y : placement.x - first.x)
			: ((placement.x - first.x) * -dy + (placement.y - first.y) * dx) / distance;
		if (height === 0) {
			return null;
		}

		this.pushUndoSnapshot(`Place ${ type } dimension`);
		const dimension = new KicadElementDimension();
		dimension.setDimensionType(type);
		dimension.setLayer(layer);
		dimension.setPoints([first, second]);
		dimension.setHeight(height);
		if (type === 'orthogonal') {
			dimension.setOrientation(orientation);
		}
		dimension.setUuid();
		const uuid = dimension.getUuid()!;

		// Real KiCad defaults (pcb_dimension.h's constructor field
		// initializers) — see KicadElementDimensionFormat/Style's own doc
		// comments for the file-format token names these map to.
		dimension.setPrefix('');
		dimension.setSuffix('');
		dimension.setUnitsMode('automatic');
		dimension.setUnitsFormat('bare_suffix');
		dimension.setPrecision(4);
		dimension.setLineThickness(0.1);
		dimension.setArrowLength(1.27);
		dimension.setTextPositionMode('manual');
		dimension.setArrowDirection('outward');
		dimension.setExtensionHeight(0.58642);
		dimension.setExtensionOffset(0.5);
		dimension.setKeepTextAligned(true);

		const lineStart = type === 'orthogonal'
			? (orientation === 0 ? { x: first.x, y: first.y + height } : { x: first.x + height, y: first.y })
			: { x: first.x - dy / distance * height, y: first.y + dx / distance * height };
		const lineEnd = type === 'orthogonal'
			? (orientation === 0 ? { x: second.x, y: second.y + height } : { x: second.x + height, y: second.y })
			: { x: second.x - dy / distance * height, y: second.y + dx / distance * height };
		const measured = type === 'orthogonal' ? (orientation === 0 ? Math.abs(dx) : Math.abs(dy)) : distance;
		const text = new KicadElementGrText(this.formatDimensionValueText(dimension, measured));
		const textAngle = type === 'aligned'
			? ((-Math.atan2(dy, dx) * 180 / Math.PI + 90) % 180) - 90
			: (orientation === 1 ? 90 : 0);
		text.setOrigin((lineStart.x + lineEnd.x) / 2, (lineStart.y + lineEnd.y) / 2, textAngle);
		text.setLayer(layer);
		text.setFont(1, 1, false, false, 0.1);
		text.setUuid();
		dimension.addChild(text);

		this.boardRoot!.rootElement.addChild(dimension);
		this.commitAstMutation();
		return uuid;
	}

	/** Real KiCad's `PCB_DIMENSION_BASE::GetValueText()` equivalent — the
	 *  measured length (already in mm, this app's native board unit),
	 *  converted to the dimension's own chosen display unit, formatted to
	 *  its precision/suppress-trailing-zeroes settings, and wrapped in
	 *  prefix/suffix/unit-suffix — or the literal override text verbatim
	 *  when override is enabled. `measuredMm` is the caller's job to compute
	 *  (aligned: point-to-point distance; orthogonal: the single-axis
	 *  delta) since that math already differs by type at every call site. */
	private formatDimensionValueText(dim: KicadElementDimension, measuredMm: number): string {
		if (dim.getOverrideTextEnabled()) {
			return dim.getOverrideText();
		}
		const unitsMode = dim.getUnitsMode();
		const unitLabel = unitsMode === 'inch' ? 'in' : unitsMode === 'mils' ? 'mil' : 'mm';
		const converted = unitsMode === 'inch' ? measuredMm / 25.4
			: unitsMode === 'mils' ? (measuredMm / 25.4) * 1000
				: measuredMm;
		const precision = dim.getPrecision();
		let valueStr = converted.toFixed(precision);
		if (dim.getSuppressZeroes() && valueStr.includes('.')) {
			valueStr = valueStr.replace(/0+$/, '').replace(/\.$/, '');
		}
		const unitsFormat = dim.getUnitsFormat();
		const suffix = unitsFormat === 'no_suffix' ? '' :
			unitsFormat === 'paren_suffix' ? ` (${ unitLabel })` : ` ${ unitLabel }`;
		return `${ dim.getPrefix() }${ valueStr }${ suffix }${ dim.getSuffix() }`;
	}

	/** Re-derives a dimension's measured value from its stored points/type
	 *  and re-runs formatDimensionValueText — called after any property
	 *  edit that affects the displayed string (precision, prefix/suffix,
	 *  units, units format, suppress-zeroes, override text/enabled), since
	 *  none of those touch the geometry translateElementGeometry/
	 *  addBoardDimension already handle. Matches real KiCad's own
	 *  updateGeometry()/updateText(), which re-derive and re-store the text
	 *  on every relevant change rather than computing it lazily at paint
	 *  time — this app's buildDimension still just renders whatever's
	 *  baked into the `gr_text` child, so that child must be kept in sync
	 *  here instead. */
	refreshDimensionText(paintId: string): boolean {
		if (this.documentType !== 'board' || !this.scene) {
			return false;
		}
		const dim = this.findDimensionByPaintId(paintId);
		const textEl = dim?.findFirstChildByClass(KicadElementGrText);
		const measuredMm = dim ? this.measuredMmForDimension(dim) : null;
		if (!dim || !textEl || measuredMm === null) {
			return false;
		}
		textEl.value = this.formatDimensionValueText(dim, measuredMm);
		this.commitAstMutation();
		return true;
	}

	/** Read-only counterpart to refreshDimensionText — the dialog's "Value"
	 *  preview row needs the measured/formatted string without writing it
	 *  back (and without requiring override to already be enabled, unlike
	 *  refreshDimensionText which only ever runs after a real property
	 *  edit). Returns null for anything that isn't a dimension. */
	getDimensionMeasuredText(paintId: string): string | null {
		if (this.documentType !== 'board' || !this.scene) {
			return null;
		}
		const dim = this.findDimensionByPaintId(paintId);
		const measuredMm = dim ? this.measuredMmForDimension(dim) : null;
		return dim && measuredMm !== null ? this.formatDimensionValueText(dim, measuredMm) : null;
	}

	/** Resolves either a dimension's own `:line` paint item OR its `:text`
	 *  sub-item (whose `element` is the gr_text child itself, `.parent` the
	 *  owning dimension — see BoardPainter.buildDimension's doc comment) to
	 *  the owning KicadElementDimension. */
	private findDimensionByPaintId(paintId: string): KicadElementDimension | undefined {
		const item = this.scene?.hitTestItems.find(candidate => candidate.id === paintId)
			?? [...(this.scene?.layerBuckets.values() ?? [])].flat().find(candidate => candidate.id === paintId);
		return item?.element instanceof KicadElementDimension ? item.element
			: item?.element instanceof KicadElementGrText && item.element.parent instanceof KicadElementDimension
				? item.element.parent
				: undefined;
	}

	private measuredMmForDimension(dim: KicadElementDimension): number | null {
		const points = dim.getPoints();
		if (points.length < 2) {
			return null;
		}
		const [p1, p2] = points;
		return dim.getDimensionType() === 'orthogonal'
			? (dim.getOrientation() === 0 ? Math.abs(p2.x - p1.x) : Math.abs(p2.y - p1.y))
			: Math.hypot(p2.x - p1.x, p2.y - p1.y);
	}

	/** The crossbar's two endpoints (real KiCad's `m_crossBarStart`/
	 *  `m_crossBarEnd`) — same offset-by-height math BoardPainter.
	 *  buildDimension recomputes every frame for drawing, duplicated here
	 *  rather than shared across the render/session split (matches how
	 *  addBoardDimension already computes this same math independently at
	 *  placement time). Null points/degenerate line -> null. */
	private computeDimensionCrossbar(dim: KicadElementDimension): { lineStart: Vec2; lineEnd: Vec2 } | null {
		const points = dim.getPoints();
		if (points.length < 2) {
			return null;
		}
		const [p1, p2] = points;
		const height = dim.getHeight() ?? 0;
		if (dim.getDimensionType() === 'orthogonal') {
			const orientation = dim.getOrientation() ?? 0;
			return orientation === 1
				? { lineStart: new Vec2(p1.x + height, p1.y), lineEnd: new Vec2(p2.x + height, p2.y) }
				: { lineStart: new Vec2(p1.x, p1.y + height), lineEnd: new Vec2(p2.x, p2.y + height) };
		}
		const dx = p2.x - p1.x, dy = p2.y - p1.y;
		const dist = Math.hypot(dx, dy) || 1;
		const nx = -dy / dist, ny = dx / dist;
		return {
			lineStart: new Vec2(p1.x + nx * height, p1.y + ny * height),
			lineEnd: new Vec2(p2.x + nx * height, p2.y + ny * height)
		};
	}

	/**
	 * The 5 real-KiCad point-editor handles for a selected dimension
	 * (PCB_POINT_EDITOR's `PCB_DIM_ALIGNED`/`PCB_DIM_ORTHOGONAL` case,
	 * pcb_point_editor.cpp): the two MEASURED points (dragging re-measures
	 * — see moveDimensionMeasuredPoint), the two CROSSBAR/arrow ends
	 * (dragging changes the crossbar height — see
	 * setDimensionHeightFromCursor), and the text's own position (dragging
	 * repositions the label — already handled generically by the text
	 * sub-item's own independent drag, see BoardPainter.buildDimension's
	 * doc comment; this just reports where to draw/hit-test that 5th
	 * handle). Accepts either the dimension's own `:line` paint id or its
	 * `:text` sub-id (whichever is currently selected). */
	getDimensionEditAnchors(paintId: string): { measured: [Vec2, Vec2]; crossbar: [Vec2, Vec2]; text: Vec2 } | null {
		const dim = this.findDimensionByPaintId(paintId);
		const points = dim?.getPoints();
		const crossbar = dim ? this.computeDimensionCrossbar(dim) : null;
		const textEl = dim?.findFirstChildByClass(KicadElementGrText);
		if (!dim || !points || points.length < 2 || !crossbar || !textEl) {
			return null;
		}
		const textOrigin = textEl.getOrigin();
		return {
			measured: [new Vec2(points[0].x, points[0].y), new Vec2(points[1].x, points[1].y)],
			crossbar: [crossbar.lineStart, crossbar.lineEnd],
			text: new Vec2(textOrigin.x, textOrigin.y)
		};
	}

	/** Drags one of a dimension's two MEASURED-point handles — re-measures
	 *  the dimension (the crossbar/arrows/extension lines all recompute
	 *  from the new points at paint time, same as any points edit) and
	 *  refreshes the displayed value text, since the distance itself just
	 *  changed. `index` is 0 or 1, matching getDimensionEditAnchors'
	 *  `measured` tuple order. */
	moveDimensionMeasuredPoint(paintId: string, index: 0 | 1, x: number, y: number): boolean {
		const dim = this.findDimensionByPaintId(paintId);
		const points = dim?.getPoints();
		if (!dim || !points || points.length < 2) {
			return false;
		}
		const next = points.map((p, i) => i === index ? { x, y } : { x: p.x, y: p.y });
		dim.setPoints(next);
		this.refreshDimensionText(paintId);
		this.commitAstMutation();
		return true;
	}

	/** Drags one of a dimension's two CROSSBAR-end (arrow) handles — changes
	 *  the crossbar height, matching real KiCad's PCB_POINT_EDITOR letting
	 *  you reshape how far the dimension line sits from the measured points
	 *  by grabbing an arrow end. `cursorX/Y` is the live drag position; the
	 *  height is derived by projecting it onto the perpendicular-to-the-
	 *  measured-line axis (aligned) or the relevant single axis (orthogonal)
	 *  — the exact same formula addBoardDimension already uses when a
	 *  dimension is first placed, just re-run continuously during the drag
	 *  instead of once at creation. Doesn't touch the displayed text (height
	 *  doesn't affect the measured value). */
	setDimensionHeightFromCursor(paintId: string, cursorX: number, cursorY: number): boolean {
		const dim = this.findDimensionByPaintId(paintId);
		const points = dim?.getPoints();
		if (!dim || !points || points.length < 2) {
			return false;
		}
		const [p1, p2] = points;
		let height: number;
		if (dim.getDimensionType() === 'orthogonal') {
			height = (dim.getOrientation() ?? 0) === 0 ? cursorY - p1.y : cursorX - p1.x;
		}
		else {
			const dx = p2.x - p1.x, dy = p2.y - p1.y;
			const dist = Math.hypot(dx, dy) || 1;
			height = ((cursorX - p1.x) * -dy + (cursorY - p1.y) * dx) / dist;
		}
		dim.setHeight(height);
		this.commitAstMutation();
		return true;
	}

	/** Reads a pad/track/via net directly from the painted item's AST node.
	 *  Clicking mid-track therefore inherits its net without splitting the
	 *  original segment—KiCad connectivity treats touching same-net copper
	 *  segments as connected without a separate junction object. */
	netIdAtScreen(screenPos: Vec2): number | null {
		if (this.documentType !== 'board' || !this.scene) {
			return null;
		}
		const hit = this.hitTestAtScreen(screenPos);
		if (!hit) {
			return null;
		}
		const element: any = this.scene.hitTestItems.find(item => item.id === hit.id)?.element;
		return typeof element?.getNetId === 'function' ? element.getNetId() : null;
	}

	/** Looks up a net's name from the board's own root-level `(net id name)`
	 *  table — the router needs net NAMES (not just ids) to resolve a
	 *  net-class via NetClassResolver, since `net_settings` in the
	 *  `.kicad_pro` keys everything by name. */
	netNameForId(netId: number | null): string | null {
		if (netId === null || this.documentType !== 'board' || !this.boardRoot?.rootElement) {
			return null;
		}
		if (!this.netNameCache) {
			this.netNameCache = new Map();
			for (const net of this.boardRoot.rootElement.findChildrenByClass(KicadElementNet)) {
				const name = (net as KicadElementNet).netName;
				if (name !== undefined) {
					this.netNameCache.set((net as KicadElementNet).id, name);
				}
			}
		}
		return this.netNameCache.get(netId) ?? null;
	}

	/** Nearest ratsnest airwire ENDPOINT (an unrouted pad's exact world
	 *  position) within `toleranceWorld` of `worldPos` — lets the route tool
	 *  start a route by clicking near (not exactly on) an unconnected pad,
	 *  snapping to its precise center and inheriting its net, matching real
	 *  KiCad's ratsnest-driven routing entry point. */
	nearestRatsnestPoint(worldPos: Vec2, toleranceWorld: number): { point: Vec2; netId: number } | null {
		if (this.documentType !== 'board') {
			return null;
		}
		let best: { point: Vec2; netId: number; dist: number } | null = null;
		for (const line of this.ratsnestLines) {
			for (const endpoint of [line.from, line.to]) {
				const dist = Math.hypot(endpoint.x - worldPos.x, endpoint.y - worldPos.y);
				if (dist <= toleranceWorld && (!best || dist < best.dist)) {
					best = { point: new Vec2(endpoint.x, endpoint.y), netId: line.netId, dist };
				}
			}
		}
		return best ? { point: best.point, netId: best.netId } : null;
	}

	/** Nearest existing-copper connection point (pad/via center, or a track
	 *  segment's endpoint) within `toleranceWorld` of `worldPos` — real
	 *  KiCad's router always snaps a click to the nearest such anchor rather
	 *  than routing from wherever inside a pad's outline was actually
	 *  clicked. Pad/via anchors use the painted shape's own bbox center
	 *  (exact for circular pads/vias, and exact for the common centered
	 *  rect/roundrect/oval pad case). Distinct
	 *  from nearestRatsnestPoint: that one only reports UNROUTED airwire
	 *  endpoints; this reports any real copper, routed or not, which is what
	 *  a click mid-route (continuing onto a target pad, or snapping onto an
	 *  already-placed via/track corner) needs.
	 *
	 *  `netFilter`, when given a real net id, restricts candidates to that
	 *  net (net-less items still match — same "unassigned is always
	 *  compatible" rule RouterNode's collision skip uses). Real KiCad's
	 *  router only magnetizes onto anchors compatible with the net actually
	 *  being routed — pass this once a route has an established net (i.e.
	 *  every anchor-snap after the route's start point) so the cursor can't
	 *  snap onto, and a click can't accidentally land a corner on, a pad
	 *  belonging to a different net. Omit it only for the very first click
	 *  of a route, which is what DETERMINES the net in the first place.
	 *
	 *  `width`, populated only for `kind: 'track'`, is that segment's own
	 *  copper width — real KiCad's "use existing track width" toolbar
	 *  toggle (BoardPointerController's `useConnectedTrackWidth`) reads it
	 *  to continue a route at the width of whatever track it's snapping
	 *  onto, instead of the selected default. */
	nearestAnchorPoint(worldPos: Vec2, toleranceWorld: number, netFilter?: number | null): {
		point: Vec2;
		netId: number | null;
		kind: 'pad' | 'via' | 'track';
		width?: number;
	} | null {
		if (this.documentType !== 'board' || !this.scene) {
			return null;
		}
		let best: {
			point: Vec2;
			netId: number | null;
			kind: 'pad' | 'via' | 'track';
			width?: number;
			dist: number
		} | null = null;
		const consider = (
			x: number, y: number, netId: number | null, kind: 'pad' | 'via' | 'track', width?: number) => {
			if (netFilter != null && netId !== null && netId !== netFilter) {
				return;
			}
			const dist = Math.hypot(x - worldPos.x, y - worldPos.y);
			if (dist <= toleranceWorld && (!best || dist < best.dist)) {
				best = { point: new Vec2(x, y), netId, kind, width, dist };
			}
		};
		for (const item of this.scene.hitTestItems) {
			if (item.kind === 'pad' || item.kind === 'via') {
				const { x, y, w, h } = item.bbox;
				consider(x + w / 2, y + h / 2, item.netId ?? null, item.kind);
			}
			else if (item.kind === 'track' && item.shape.type === 'segment') {
				consider(item.shape.x1, item.shape.y1, item.netId ?? null, 'track', item.shape.width);
				consider(item.shape.x2, item.shape.y2, item.netId ?? null, 'track', item.shape.width);
			}
		}
		return best;
	}

	/**
	 * Direct-purpose port of real KiCad's `PCB_GRID_HELPER::BestSnapAnchor`
	 * (`pcbnew/tools/pcb_grid_helper.cpp`) as used by `DRAWING_TOOL::
	 * DrawDimension` (`pcbnew/tools/drawing_tool.cpp:1698`) — every dimension
	 * click there is `grid.BestSnapAnchor(cursorPos, nullptr, GRID_GRAPHICS)`,
	 * not a plain grid-snap, which is why a dimension's endpoints in real
	 * KiCad land exactly on pad centers, footprint corners, and graphic-item
	 * endpoints instead of wherever the cursor happened to be. Not net-
	 * filtered (dimensions aren't electrical items, unlike routing's
	 * `nearestAnchorPoint`).
	 *
	 * Real KiCad's `computeAnchors` (same file, `:1333` on) walks every
	 * visible item type and calls `addAnchor` for a curated set of points per
	 * type — this ports the subset that actually matters for dimensioning a
	 * board: pad/via centers, track endpoints, a footprint's own anchor
	 * position plus its selection-hull corners, and every graphic line/rect/
	 * circle/arc's own endpoints/corners/midpoints/center (its `addAnchor`
	 * calls at `:1376`, `:1428-1432`, `:1496-1505`, `:1520-1533`). Doesn't
	 * port table/image/text/group anchors or intersection/construction-line
	 * snapping — out of scope for a first pass at "dimensions actually snap
	 * to something."
	 */
	nearestBoardGraphicAnchor(worldPos: Vec2, toleranceWorld: number): Vec2 | null {
		if (this.documentType !== 'board' || !this.scene) {
			return null;
		}
		let best: { point: Vec2; dist: number } | null = null;
		const consider = (x: number, y: number) => {
			const dist = Math.hypot(x - worldPos.x, y - worldPos.y);
			if (dist <= toleranceWorld && (!best || dist < best.dist)) {
				best = { point: new Vec2(x, y), dist };
			}
		};
		const considerLineLike = (el: any) => {
			const { start, end } = el.getStartEnd();
			const isRect = typeof el.name === 'string' && el.name.endsWith('_rect');
			if (!isRect) {
				consider(start.x, start.y);
				consider(end.x, end.y);
				consider((start.x + end.x) / 2, (start.y + end.y) / 2);
				return;
			}
			const corners = [
				{ x: start.x, y: start.y }, { x: end.x, y: start.y },
				{ x: end.x, y: end.y }, { x: start.x, y: end.y }
			];
			consider((start.x + end.x) / 2, (start.y + end.y) / 2);
			for (let i = 0; i < 4; i++) {
				const a = corners[i]!, b = corners[(i + 1) % 4]!;
				consider(a.x, a.y);
				consider((a.x + b.x) / 2, (a.y + b.y) / 2);
			}
		};
		const considerCircleLike = (el: any) => {
			const { x: cx, y: cy } = el.getCenter();
			const { x: ex, y: ey } = el.getEnd();
			const r = Math.hypot(ex - cx, ey - cy);
			consider(cx, cy);
			consider(cx + r, cy);
			consider(cx - r, cy);
			consider(cx, cy + r);
			consider(cx, cy - r);
		};
		const considerArcLike = (el: any) => {
			const { start, mid, end } = el.getStartMidEnd();
			consider(start.x, start.y);
			consider(mid.x, mid.y);
			consider(end.x, end.y);
			try {
				const { centerX, centerY } = el.getArcCenterRadiusAngles();
				consider(centerX, centerY);
			}
			catch {
				// Collinear start/mid/end (degenerate arc) — no well-defined
				// center to offer as an anchor, same as real KiCad's own
				// GetCenter() guard for a zero-curvature arc.
			}
		};
		// Deliberately scans layerBuckets (every drawn item), not hitTestItems
		// (only individually CLICKABLE items — plain board-level gr_line/gr_arc
		// and every footprint-owned fp_line/fp_rect/fp_circle/fp_arc are
		// `hitTestable: false` there, matching real KiCad's own selection
		// rule that footprint-owned graphics resolve clicks to the whole
		// footprint instead — see BoardPainter.buildFpLine's doc comment).
		// That rule is specifically about mouse-picking; real KiCad's own
		// grid helper snaps to those same items regardless (confirmed
		// against a board using a plain gr_line for its Edge.Cuts outline —
		// far and away the single most common dimension target — which
		// silently produced ZERO anchors when this scanned hitTestItems).
		const seen = new Set<any>();
		for (const bucket of this.scene.layerBuckets.values()) {
			for (const item of bucket) {
				if (seen.has(item)) {
					continue;
				}
				seen.add(item);
				if (item.kind === 'pad' || item.kind === 'via') {
					const { x, y, w, h } = item.bbox;
					consider(x + w / 2, y + h / 2);
				}
				else if (item.kind === 'track' && item.shape.type === 'segment') {
					consider(item.shape.x1, item.shape.y1);
					consider(item.shape.x2, item.shape.y2);
				}
				else if (item.kind === 'footprint') {
					const origin = (item.element as any)?.getOrigin?.();
					if (origin) {
						consider(origin.x, origin.y);
					}
					if (item.shape.type === 'polygon') {
						for (const pt of item.shape.points) {
							consider(pt.x, pt.y);
						}
					}
				}
				else if (item.kind === 'graphic') {
					const el = item.element as any;
					if (
						el instanceof KicadElementGrLine || el instanceof KicadElementFpLine ||
						el instanceof KicadElementGrRect || el instanceof KicadElementFpRect
					) {
						considerLineLike(el);
					}
					else if (el instanceof KicadElementGrCircle || el instanceof KicadElementFpCircle) {
						considerCircleLike(el);
					}
					else if (el instanceof KicadElementGrArc || el instanceof KicadElementFpArc) {
						considerArcLike(el);
					}
				}
			}
		}
		return best ? (best as { point: Vec2; dist: number }).point : null;
	}

	/** Public counterpart to hitTestToleranceWorld — the route tool's
	 *  ratsnest-snap radius should track the same zoom-derived, comfortable-
	 *  at-any-zoom pixel tolerance every other click target already uses. */
	get pickToleranceWorld(): number {
		return this.hitTestToleranceWorld();
	}

	/** Resolves the schematic connection name for a selected paint item id.
	 *  Returns null for objects that aren't part of a net (e.g. plain text,
	 *  symbols without a single resolved net, non-wire geometry). */
	connectionNameForPaintId(id: string): string | null {
		if (this.documentType !== 'schematic' || !this.schScene) {
			return null;
		}
		const item = this.findPaintItemById(id);
		return this.netNameForPaintItem(item);
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

	private findPaintItemById(id: string): SchPaintedItem | null {
		if (!this.schScene) {
			return null;
		}
		for (const bucket of this.schScene.layerBuckets.values()) {
			const match = bucket.find(item => item.id === id);
			if (match) {
				return match;
			}
		}
		return null;
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

	private wireSegmentForItem(item: SchPaintedItem | null | undefined): {
		x1: number;
		y1: number;
		x2: number;
		y2: number
	} | null {
		if (!item || (item.kind !== 'wire' && item.kind !== 'bus')) {
			return null;
		}
		const shape = item.shape as { type?: string; x1?: number; y1?: number; x2?: number; y2?: number } | undefined;
		if (!shape || shape.type !== 'segment') {
			return null;
		}
		if (typeof shape.x1 !== 'number' || typeof shape.y1 !== 'number' || typeof shape.x2 !== 'number'
			|| typeof shape.y2 !== 'number') {
			return null;
		}
		return { x1: shape.x1, y1: shape.y1, x2: shape.x2, y2: shape.y2 };
	}

	private pointForAttachedItem(item: SchPaintedItem): { x: number; y: number } {
		if (item.kind === 'label') {
			// A label's painted bbox is offset from its electrical attach point
			// by text clearance and justification. Net lookup must use the
			// element origin, which is the point KiCad connects to the wire.
			const origin = (item.element as any)?.getOrigin?.();
			if (origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)) {
				return { x: origin.x, y: origin.y };
			}
			return {
				x: item.bbox.x + item.bbox.w / 2,
				y: item.bbox.y + item.bbox.h / 2
			};
		}
		if (item.kind === 'pin') {
			// Pin shape.x1/y1 is the outer (wire-facing) endpoint; the bbox
			// center is somewhere along the pin body and is not connectable.
			const shape = item.shape as any;
			if (shape?.type === 'segment' && Number.isFinite(shape.x1) && Number.isFinite(shape.y1)) {
				return { x: shape.x1, y: shape.y1 };
			}
			const origin = (item.element as any)?.getOrigin?.();
			if (origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)) {
				return { x: origin.x, y: origin.y };
			}
			return { x: item.bbox.x + item.bbox.w / 2, y: item.bbox.y + item.bbox.h / 2 };
		}
		if (item.kind === 'symbol') {
			return {
				x: item.bbox.x + item.bbox.w / 2,
				y: item.bbox.y + item.bbox.h / 2
			};
		}
		return { x: item.bbox.x, y: item.bbox.y };
	}

	private netNameForWireItem(item: SchPaintedItem): string | null {
		if (!this.schScene) {
			return null;
		}
		const startSegment = this.wireSegmentForItem(item);
		if (!startSegment) {
			return null;
		}
		const visited = new Set<string>();
		const queue: SchPaintedItem[] = [item];
		const names = new Set<string>();
		const connectTolerance = 0.12;
		const attachTolerance = 0.35;

		const addCandidateName = (candidate: SchPaintedItem) => {
			if (candidate.kind === 'label' && candidate.labelKind !== 'symbol-field' && candidate.labelName) {
				names.add(candidate.labelName);
				return;
			}
			if (candidate.kind === 'pin' && candidate.element instanceof KicadElementPin) {
				const ref = candidate.refDesignator;
				if (!ref) {
					return;
				}
				const { number } = typeof candidate.element.getPin === 'function' ? candidate.element.getPin() :
					{ number: '' };
				if (!number) {
					return;
				}
				const summary = this.getConnectivitySummary();
				const component = summary?.components.find(c => c.ref === ref);
				const matchingPin = component?.pins.find(p => p.number === number);
				if (matchingPin?.net) {
					names.add(matchingPin.net);
				}
				return;
			}
			if (candidate.kind === 'symbol' && candidate.refDesignator) {
				const summary = this.getConnectivitySummary();
				const component = summary?.components.find(c => c.ref === candidate.refDesignator);
				if (component) {
					const nets = [...new Set(component.pins.map(p => p.net).filter(Boolean) as string[])];
					if (nets.length === 1) {
						names.add(nets[0]!);
					}
				}
			}
		};

		const pointsClose = (x1: number, y1: number, x2: number, y2: number) => Math.hypot(x1 - x2, y1 - y2)
			<= connectTolerance;
		const itemTouchesSegment = (
			candidate: SchPaintedItem, segment: { x1: number; y1: number; x2: number; y2: number }) => {
			const anchor = this.pointForAttachedItem(candidate);
			return distanceToSegment(anchor.x, anchor.y, segment.x1, segment.y1, segment.x2, segment.y2)
				<= attachTolerance;
		};

		while (queue.length) {
			const current = queue.shift()!;
			if (!visited.add(current.id)) {
				continue;
			}
			const currentSegment = this.wireSegmentForItem(current);
			if (currentSegment) {
				for (const candidate of this.schScene.hitTestItems) {
					if (candidate.id === current.id) {
						continue;
					}
					const otherSegment = this.wireSegmentForItem(candidate);
					if (otherSegment) {
						const connected = pointsClose(
								currentSegment.x1, currentSegment.y1, otherSegment.x1, otherSegment.y1)
							|| pointsClose(currentSegment.x1, currentSegment.y1, otherSegment.x2, otherSegment.y2)
							|| pointsClose(currentSegment.x2, currentSegment.y2, otherSegment.x1, otherSegment.y1)
							|| pointsClose(currentSegment.x2, currentSegment.y2, otherSegment.x2, otherSegment.y2);
						if (connected && !visited.has(candidate.id) && !queue.includes(candidate)) {
							queue.push(candidate);
						}
						continue;
					}
					if (itemTouchesSegment(candidate, currentSegment) && !visited.has(candidate.id) && !queue.includes(
						candidate)) {
						addCandidateName(candidate);
					}
				}
			}
			addCandidateName(current);
		}

		return names.size === 1 ? [...names][0]! : null;
	}

	private netNameForWireByMembership(itemId: string): string | null {
		const summary = this.getConnectivitySummary();
		if (!summary?.nets?.length) {
			return null;
		}
		for (const net of summary.nets) {
			if (!net?.name) {
				continue;
			}
			const ids = this.paintIdsForNet(net.name);
			if (ids.has(itemId)) {
				return net.name;
			}
		}
		return null;
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
		if (item.kind === 'wire' || item.kind === 'bus') {
			return this.netNameForWireItem(item) ?? this.netNameForWireByMembership(item.id);
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
				const nearEnd = Math.hypot(current.x - wshape.x2, current.y - wshape.y2) <= WIRE_SNAP;
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
		// !hasResized also catches a canvas that's never been through a real
		// resize() at all — its HTML default (300×150) is comfortably above
		// minFitViewportPx, so the size check alone would miss it (see
		// hasResized's doc comment).
		const viewW = this.canvas2d.width;
		const viewH = this.canvas2d.height;
		if (
			!this.hasResized
			|| viewW < KicadRenderSession.minFitViewportPx
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

	/** Shows or hides the procedural editor grid without changing snapping. */
	setGridVisible(visible: boolean): void {
		if (this.gridVisible === visible) {
			return;
		}
		this.gridVisible = visible;
		this.scheduleRender();
	}

	/** Color is baked into WebGL scene buffers, unlike Canvas2D's draw-time
	 * styles. Rebuild the scene after replacing the shared schematic palette. */
	refreshTheme(): void {
		this.geometryDirty = true;
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

	/**
	 * Brings the selected PCB layer to the front of the board geometry, like
	 * PCB Editor's SetHighContrastLayer()/SetTopLayer path. UI and selection
	 * overlays remain in the dynamic overlay pass above it.
	 */
	setActiveBoardLayer(layer: string): void {
		if (this.documentType !== 'board' || !this.scene?.layersPresent.includes(layer)
			|| this.activeBoardLayer === layer) {
			return;
		}
		this.activeBoardLayer = layer;
		// WebGL bakes paint order into its static vertex buffer; Canvas2D picks
		// up the new order on its next frame. Marking dirty handles both paths.
		this.geometryDirty = true;
		this.scheduleRender();
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

	async loadBoardText(text: string, options?: { preserveView?: boolean }): Promise<LoadResult> {
		this.documentType = 'board';
				const t0 = performance.now();
				const rootElement = parseBoardText(text);
				this.repairMalformedBoardZoneOutlines(rootElement);
				this.repairDetachedBoardZoneFields(rootElement);
				const parseMs = performance.now() - t0;
		const boardRoot = { rootElement };
		this.boardRoot = boardRoot;
		this.boardTextSnapshot = text;
		this.netNameCache = null;
		const setup = rootElement.findFirstChildByName?.('setup') as any;
		this.boardGridOrigin = readBoardOrigin(setup, 'grid_origin');
		this.boardDrillPlaceOrigin = readBoardOrigin(setup, 'aux_axis_origin');

		const t1 = performance.now();
		const previousLayerState = this.layerState;
		this.scene = this.painter.build(boardRoot);
		const graph = buildCopperGraph(this.scene);
		this.copperGraphCache = { scene: this.scene, graph };
		this.ratsnestLines = buildBoardRatsnest(this.scene, undefined, graph);
		this.lastRatsnestCommitSignature = null;
		const buildMs = performance.now() - t1;
		this.layerState = defaultLayerState(this.scene.layersPresent);
		// preserveView reloads the SAME document (undo/redo, resyncBoardFromAst
		// after an external AST edit) rather than opening a different file — the
		// user's Appearance panel choices (e.g. a hidden F.Fab, sourced from the
		// project's .kicad_prl on initial open) must survive that reload instead
		// of silently reverting to defaults. Exact same merge
		// rebuildBoardSceneIfPending already does for every ordinary structural
		// edit's own scene rebuild (see its doc comment) — this was the one
		// reload path that had been missed, which is why undo specifically was
		// observed resurrecting hidden layers: every other edit already went
		// through the incremental path that preserves this correctly. A fresh
		// file open (preserveView unset) deliberately skips this — there's no
		// "previous" state from an unrelated file worth keeping.
		if (options?.preserveView) {
			for (const [layer, state] of this.layerState) {
				const previous = previousLayerState.get(layer);
				if (previous) {
					state.visible = previous.visible;
					state.opacity = previous.opacity;
				}
			}
		}
		this.geometryDirty = true;
		this.selectedIds = new Set();
		// A fresh parse means every element reference held elsewhere (undo/
		// cancel reloading mid-drag, in particular) is now stale — a
		// leftover drag-preview entry would otherwise keep drawing a ghost
		// forever, since nothing else ever clears dragPreviewFootprints.
		this.boardDirtyFootprints.clear();
		this.dragPreviewFootprints.clear();
		this.dragPreviewRatsnestEdges = [];
		this.highlightedBoardNetId = null;
		this.highlightedBoardNetName = null;

		if (!options?.preserveView) {
			this.fitToItems(this.scene.hitTestItems);
		}
		this.scheduleRender();

		return { parseMs, buildMs, layersPresent: this.scene.layersPresent };
	}

	/** Board-side twin of resyncSchematicFromAst — same reason: external
	 *  callers (e.g. Update PCB from Schematic) that mutate the currently-
	 *  loaded board's AST directly must resync this session's live text
	 *  afterward or SessionController.saveProject()'s re-derive-from-
	 *  getBoardText() step silently discards the edit. */
	async resyncBoardFromAst(text: string): Promise<void> {
		await this.loadBoardText(text, { preserveView: true });
	}

	/**
	 * Lightweight footprint-only preview loader — parses a standalone
	 * `(footprint ...)` .kicad_mod text and paints just that footprint's
	 * own pads/silkscreen/fab/courtyard, skipping the full board pipeline
	 * loadBoardText() runs (tracks/zones/vias/ratsnest — all meaningless
	 * for one footprint out of board context). Mirrors how SymbolChooser's
	 * own preview injects a bare symbol into a session without a full
	 * schematic document behind it. Returns false (session left untouched)
	 * if the text doesn't parse to a real footprint; the caller is
	 * responsible for calling render() afterward (this only loads/fits,
	 * matching SymbolChooser.renderPreview()'s own synchronous-render
	 * pattern rather than this class's normal scheduleRender() debounce,
	 * since a chooser's preview canvas isn't part of the main render loop).
	 */
	loadFootprintPreviewText(sourceText: string): boolean {
		const parsedFootprint = parseText(sourceText);
		const footprint = parsedFootprint.name === 'footprint'
			? parsedFootprint
			: parsedFootprint.children.find((child: any) => child.name === 'footprint');
		if (!footprint) {
			return false;
		}
		// A minimal real layer table — not a real board document, just
		// enough for BoardPainter.getGlobalLayerNames() to resolve a pad's
		// "*.Cu"/"*.Mask" wildcard layers correctly (the same layer set
		// every real board ships) — buildFootprintPreviewItems only reads
		// this for that lookup.
		const layersDoc = '(kicad_pcb (layers '
			+ '(0 "F.Cu" signal) (31 "B.Cu" signal) (34 "B.Paste" user) (35 "F.Paste" user) '
			+ '(36 "B.SilkS" user) (37 "F.SilkS" user) (38 "B.Mask" user) (39 "F.Mask" user) '
			+ '(44 "Edge.Cuts" user) (46 "B.CrtYd" user) (47 "F.CrtYd" user) (48 "B.Fab" user) (49 "F.Fab" user)))';
		const fakeBoard = { rootElement: parseText(layersDoc) };

		const items = this.painter.buildFootprintPreviewItems(fakeBoard, footprint);
		const layerBuckets = new Map<string, PaintedItem[]>();
		for (const item of items) {
			(layerBuckets.get(item.layer) ?? layerBuckets.set(item.layer, []).get(item.layer)!).push(item);
		}
		this.documentType = 'board';
		this.boardRoot = fakeBoard;
		this.netNameCache = null;
		const previewScene: LayeredBoardScene = {
			layersPresent: [...layerBuckets.keys()],
			layerBuckets,
			hitTestItems: items,
			zoneFills: [],
			// A footprint-preview document has no board-level Edge.Cuts, so it
			// intentionally carries no physical-board body shadow.
			boardBodyRings: [],
			copperLayerStack: ['F.Cu', 'B.Cu'],
			declaredLayers: [...layerBuckets.keys()]
		};
		this.scene = previewScene;
		this.ratsnestLines = [];
		this.lastRatsnestCommitSignature = null;
		this.layerState = defaultLayerState(previewScene.layersPresent);
		this.geometryDirty = true;
		this.selectedIds = new Set();
		this.fitToItems(previewScene.hitTestItems);
		return true;
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
		this.repairLibSymbolsPosition(root);
		this.repairDerivedLibSymbols(root);
		if (typeof root.write === 'function') {
			this.boardTextSnapshot = String(root.write());
			return this.boardTextSnapshot;
		}
		return '';
	}

	/** Repairs a `lib_symbols` block left at the FRONT of the schematic root
	 *  by ensureLibSymbol's earlier `unshift()` bug (now fixed at creation
	 *  time — see that method's doc comment — but an already-loaded document
	 *  whose `lib_symbols` was created before the fix still carries the
	 *  misplaced block forward untouched, since ensureLibSymbol only fixes
	 *  the POSITION when it creates a fresh one, never when it finds an
	 *  existing one already in the wrong spot). Repair at serialization time
	 *  so exporting/saving an already-corrupted project genuinely fixes it
	 *  rather than preserving the corruption — same rationale as this file's
	 *  own repairMalformedBoardZoneOutlines/repairDetachedBoardZoneFields for
	 *  the board side. */
	private repairLibSymbolsPosition(root: any): void {
		const children = root?.children as any[] | undefined;
		if (!children) {
			return;
		}
		const libSymbolsIndex = children.findIndex(c => c?.name === 'lib_symbols');
		if (libSymbolsIndex === -1) {
			return;
		}
		// Remove first, THEN scan for the header run — scanning with
		// lib_symbols still in the array would stop the run immediately when
		// lib_symbols itself sits before/inside it (lib_symbols isn't a
		// header name), miscounting the target index as 0 and wrongly
		// concluding "already correct" for exactly the corrupted case this
		// exists to fix.
		const [libSymbols] = children.splice(libSymbolsIndex, 1);
		const headerNames = new Set(['version', 'generator', 'generator_version', 'uuid', 'paper']);
		let correctIndex = 0;
		for (const child of children) {
			if (!headerNames.has(child?.name)) {
				break;
			}
			correctIndex++;
		}
		children.splice(correctIndex, 0, libSymbols);
	}

	/** Repairs any `lib_symbols` entry still carrying `(extends ...)` — left
	 *  over from before addLibrarySymbolFromText started flattening derived
	 *  placements (see that method's doc comment for why real KiCad can
	 *  never resolve an `extends` reference inside a SCHEMATIC's own
	 *  lib_symbols cache: its parser always uses a throwaway, empty map
	 *  there). An already-placed symbol from before that fix keeps its
	 *  extends-based entry forever otherwise, since nothing else in the
	 *  load→edit→save pipeline ever revisits an existing lib_symbols entry.
	 *  Repair at serialization time, same rationale/pattern as
	 *  repairLibSymbolsPosition just above. Silently leaves an entry alone
	 *  if its base isn't present in the same lib_symbols block (nothing to
	 *  flatten against — shouldn't happen for anything this app itself
	 *  wrote, but a hand-edited or foreign file could hit it). */
	private repairDerivedLibSymbols(root: any): void {
		const libSymbols = root?.children?.find((c: any) => c?.name === 'lib_symbols');
		const children = libSymbols?.children as KicadElementSymbol[] | undefined;
		if (!children) {
			return;
		}
		for (let i = 0; i < children.length; i++) {
			const entry = children[i];
			if (!(entry instanceof KicadElementSymbol) || !entry.isDerived()) {
				continue;
			}
			const baseName = entry.getExtends()!;
			const base = children.find(c => c instanceof KicadElementSymbol && c.symbolName === baseName)
				?? children.find(c => c instanceof KicadElementSymbol && c.symbolName?.endsWith(`:${ baseName }`));
			if (!base || !entry.symbolName) {
				continue;
			}
			const flattened = this.flattenDerivedLibSymbol(base, entry, entry.symbolName);
			flattened.rootLevel = entry.rootLevel;
			flattened.parent = entry.parent;
			children[i] = flattened;
		}
	}

	/**
	 * Board-side counterpart to {@link getSchematicText} — serializes the
	 * currently loaded board AST (including any mutations from
	 * {@link moveFootprintByPaintId}). Empty string if none loaded.
	 */
	getBoardText(): string {
		if (this.documentType !== 'board' || !this.boardRoot?.rootElement) {
			return '';
		}
		const root = this.boardRoot.rootElement;
		this.repairMalformedBoardZoneOutlines(root);
		this.repairDetachedBoardZoneFields(root);
		if (typeof root.write === 'function') {
			return String(root.write());
		}
		return '';
	}

	/** Repairs the anonymous zone-outline group emitted by early KiOnline
	 * builds: `(( pts ...))`. KiCad itself rejects it, but our permissive
	 * S-expression reader can still recover every `(xy ...)` point. Repair
	 * during load and before serialization so refreshing an existing project
	 * genuinely upgrades its stored board rather than preserving corruption. */
	private repairMalformedBoardZoneOutlines(root: any): void {
		const zones = root?.findChildrenByClass?.(KicadElementZone) as KicadElementZone[] | undefined;
		if (!zones?.length) {
			return;
		}
		for (const zone of zones) {
			if (zone.getPolygon().length > 0) {
				continue;
			}
			const malformed = zone.children.find(child => child.name === '('
				&& child.attributes[0]?.value === 'pts');
			if (!malformed) {
				continue;
			}
			const points = malformed.children
				.filter(child => child.name === 'xy')
				.map(child => ({ x: Number(child.attributes[0]?.value), y: Number(child.attributes[1]?.value) }))
				.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
			if (points.length < 3) {
				continue;
			}
			const replacement = new KicadElementPolygon();
			replacement.setPoints(points);
			replacement.parent = zone;
			replacement.rootLevel = malformed.rootLevel;
			const index = zone.children.indexOf(malformed);
			zone.children.splice(index, 1, replacement);
		}
	}

	/** Reattaches zone fields that an older permissive parse left at the
	 * board root after an outline's premature close. This also fixes an
	 * already-loaded board at export time, where the raw-text migration cannot
	 * run again. A real board-level `(layers ...)` table never immediately
	 * follows an outline-only zone, so requiring that first detached field
	 * keeps the recovery deliberately narrow. */
	private repairDetachedBoardZoneFields(root: any): void {
		const children = root?.children as any[] | undefined;
		if (!children) {
			return;
		}
		const zoneFieldNames = new Set([
			'net', 'net_name', 'layer', 'layers', 'property', 'tstamp', 'uuid', 'hatch', 'priority',
			'connect_pads', 'min_thickness', 'filled_areas_thickness', 'fill', 'placement', 'keepout',
			'polygon', 'filled_polygon', 'fill_segments', 'attr', 'locked', 'name'
		]);
		for (let index = 0; index < children.length; index++) {
			const zone = children[index];
			if (!(zone instanceof KicadElementZone) && zone?.name !== 'zone') {
				continue;
			}
			const hasOutline = zone.children?.some((child: any) => child.name === 'polygon');
			const hasLayer = zone.children?.some((child: any) => child.name === 'layer' || child.name === 'layers');
			const firstDetached = children[index + 1];
			if (!hasOutline || hasLayer || (firstDetached?.name !== 'layer' && firstDetached?.name !== 'layers')) {
				continue;
			}
			while (index + 1 < children.length && zoneFieldNames.has(children[index + 1]?.name)) {
				const [field] = children.splice(index + 1, 1);
				zone.addChild(field);
			}
		}
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
		const rootElement = parseText(text);
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

	/** External callers (e.g. the Symbol Fields Table) that mutate the AST of
	 *  the CURRENTLY-loaded schematic directly, bypassing this session's own
	 *  edit methods, must resync this session's live text afterward — the
	 *  save path (SessionController.saveProject()) re-derives the open
	 *  sheet's rootElement from getSchematicText(), so an external mutation
	 *  invisible to that text would otherwise be silently discarded on save.
	 *  preserveView keeps the camera from jumping, matching the same
	 *  {...this.schematicDocInfo, preserveView: true} pattern this class
	 *  already uses internally for undo/redo. */
	async resyncSchematicFromAst(text: string): Promise<void> {
		await this.loadSchematicText(text, { ...this.schematicDocInfo, preserveView: true });
	}

	/**
	 * Common tail for every method that mutates the live schematic AST directly
	 * (as opposed to reloading text): rebuild the scene from the current tree,
	 * reset layer visibility state, and schedule a repaint. No re-parsing.
	 */
	/** >0 while a batch of mutations is in progress — see beginBatch(). */
	private batchDepth = 0;

	private commitAstMutation(): void {
			SessionState.commitAstMutation(this);
		}

	/** Dispatches to whichever document type is actually loaded — every
	 *  existing call site only ever runs while documentType==='schematic'
	 *  (each caller guards on that itself before reaching here), so this
	 *  branch is a no-op change for schematic and purely additive for board.
	 *  This is the SAFE, CONSERVATIVE board path (a full rebuild) — used by
	 *  every board mutation method except the footprint move/group-drag
	 *  ones, which call scheduleFootprintRebuild() instead (see its doc
	 *  comment for why). */
	private rebuildActiveScene(): void {
			rebuildActiveScene(this);
		}

	/** Fast path for a footprint move/group-drag: marks just that footprint
	 *  for an INCREMENTAL rebuild (BoardPainter.updateFootprintItems() only
	 *  re-walks this one footprint's own pads/graphics/text, not the rest
	 *  of the board) instead of the full-board rebuildActiveScene() path.
	 *  Re-decoding stroke-font text and recomputing pad matrices for every
	 *  OTHER unchanged footprint, every animation frame of a drag, was the
	 *  dominant cost behind the reported FPS drop on real boards — a
	 *  connector with many pads doesn't cost any more than a 2-pad part
	 *  here, since only ITS OWN items are rebuilt either way. Deliberately
	 *  does not touch ratsnest (see refreshBoardRatsnest's doc comment —
	 *  that stays a separate, deliberately less-frequent recompute) or
	 *  boardStructureDirty (a pending full rebuild, e.g. from an add/delete
	 *  earlier in the same batch, must still win — see
	 *  rebuildBoardSceneIfPending). getBoardText() serializes straight from
	 *  boardRoot (the AST), not from this scene, so undo/save correctness
	 *  is unaffected by the deferral either way. */
	private scheduleFootprintRebuild(footprint: any): void {
			scheduleFootprintRebuild(this, footprint);
		}

	/** Rotate/flip's counterpart to scheduleFootprintRebuild — those commit
	 *  through commitAstMutation()'s full boardStructureDirty rebuild
	 *  unconditionally, which re-adds the footprint to the static scene at
	 *  its new orientation while drawBoardDragPreview() keeps drawing the
	 *  stale pre-rotation preview on top for the rest of the gesture (the
	 *  preview is only refreshed by updateBoardDragPreview(), driven by
	 *  mousemove, not by a mid-drag keypress) — two copies on screen at
	 *  once. If a drag-preview owns this footprint, refresh its preview
	 *  items in place (same builder beginBoardDragPreview seeds from) so it
	 *  reflects the rotation immediately and the static scene is left
	 *  alone until the drag ends; otherwise fall back to the normal
	 *  incremental rebuild. */
	private rebuildAfterFootprintGeometryEdit(footprint: any): void {
			rebuildAfterFootprintGeometryEdit(this, footprint);
		}

	private rebuildSchScene(): void {
			rebuildSchScene(this);
		}

	/** Called from render(), never schedules another render itself (the
	 *  caller is already mid-frame). Branches between the full rebuild
	 *  (structural changes — add/delete/route/zone edit/...) and the cheap
	 *  incremental per-footprint one (continuous move/group-drag) — see
	 *  scheduleFootprintRebuild's doc comment for why the split exists. A
	 *  pending full rebuild always wins over incremental ones, since a
	 *  structural change (e.g. this exact footprint got deleted earlier in
	 *  the same frame) can invalidate what an incremental update would
	 *  otherwise touch. */
	private rebuildBoardSceneIfPending(): void {
			rebuildBoardSceneIfPending(this);
		}

	/** Incremental ratsnest update for a drag: recomputes airwires only for
	 *  the net(s) the given footprint(s) actually belong to (via
	 *  buildBoardRatsnest's netFilter) and splices those into the existing
	 *  this.ratsnestLines, leaving every other net's lines untouched. A
	 *  footprint's own pads keep the same net assignments while it moves —
	 *  only positions change — so this stays correct across the whole drag,
	 *  cheaply, unlike a full per-frame buildBoardRatsnest() (whole-board
	 *  union-find + MST) which is what made ratsnest a per-frame liability
	 *  in the first place. */
	private refreshRatsnestForFootprints(footprints: Iterable<any>): void {
				Layers.refreshRatsnestForFootprints(this, footprints);
		}

	/** Starts a KiCad-VIEW-preview-style drag for one or more footprints
	 *  (paintId may be a pad hit or the synthetic whole-footprint hit, same
	 *  as moveFootprintByPaintId). Real KiCad's own MOVE tool never
	 *  re-tessellates the moved item into its cached VIEW geometry on every
	 *  step of a drag — it hides the item and draws a live copy through a
	 *  VIEW_GROUP preview overlay instead, only baking the final position
	 *  back into the cache once, on drop (see VIEW::Update/AddToPreview in
	 *  KiCad's own view.cpp). This mirrors that: removes each footprint from
	 *  the real scene right now (one full static retessellation, same cost
	 *  as any other structural edit — but only ONE for the whole drag, not
	 *  one per frame) and starts tracking it here so drawBoardDragPreview()
	 *  can draw it through the cheap per-frame dynamic path for the rest of
	 *  the gesture. Call updateBoardDragPreview() after mutating position
	 *  each frame, and endBoardDragPreview() once on release. */
	beginBoardDragPreview(paintIds: Iterable<string>): void {
			Layers.beginBoardDragPreview(this, paintIds);
		}

	/** Finds every existing ratsnest airwire endpoint that sits on one of
	 *  this (about-to-be-dragged) footprint's own pads and records it in
	 *  dragPreviewRatsnestEdges — see that field's doc comment. Must run
	 *  BEFORE removeFootprintItems() pulls the footprint's pads out of
	 *  scene.hitTestItems, since it reads their CURRENT (pre-drag) world
	 *  centers to match against buildBoardRatsnest's own centerOf()
	 *  computation (identical formula, so an exact-ish match is reliable —
	 *  the epsilon only guards float rounding, not real ambiguity). */
	private captureDragPreviewRatsnestEdges(footprint: any): void {
			Layers.captureDragPreviewRatsnestEdges(this, footprint);
		}

	/** Call once per frame (after the footprint(s)' AST position has already
	 *  been mutated, e.g. via moveFootprintByPaintId/translateBoardSelection)
	 *  while a drag-preview is active. Cheap: rebuilds only the preview
	 *  footprints' own items (a few dozen shapes, not the whole board) for
	 *  drawBoardDragPreview() to draw next frame, and keeps ratsnest airwires
	 *  live by temporarily splicing those preview pads' positions into a
	 *  throwaway scene view for buildBoardRatsnest — the real scene can't be
	 *  used directly since these footprints were removed from it in
	 *  beginBoardDragPreview. Never touches the static GPU buffer. */
	updateBoardDragPreview(): void {
			Layers.updateBoardDragPreview(this);
		}

	/** Ends an active drag-preview: bakes every preview footprint's final
	 *  position back into the real scene (one more full static
	 *  retessellation — same "VIEW::Update on drop" idea as
	 *  beginBoardDragPreview's doc comment) and refreshes their ratsnest
	 *  through the normal net-scoped incremental path. Safe to call with no
	 *  preview active (no-op). */
	endBoardDragPreview(): void {
			Layers.endBoardDragPreview(this);
		}

	/** Segment ids currently pulled out of the static scene by
	 *  beginTrackDragPreview, for endTrackDragPreview to restore. */
	private hiddenTrackDragIds = new Set<string>();

	/** Starts a track-body drag (BoardPointerController's 'track-body'
	 *  gesture): removes the assembled line's own segments from the static
	 *  scene, the same "hide the original, draw a live copy separately"
	 *  idea beginBoardDragPreview uses for footprints (see its doc comment)
	 *  — simpler here since there's no per-frame preview-items list to
	 *  maintain: BoardPointerController already draws the in-progress shape
	 *  through the ordinary route-style editPreview overlay
	 *  (setEditPreview), so this only needs a hide/restore pair, not a
	 *  redraw-every-frame path. Without this, the untouched original
	 *  segments — still selected (this gesture arms right after a
	 *  session.select() call), so drawn in the selection-highlight color —
	 *  would sit visibly in place under the moving live preview for the
	 *  whole drag, reading as the selection itself fighting the drag. Call
	 *  endTrackDragPreview() once on release (commit or plain click),
	 *  exactly like beginBoardDragPreview/endBoardDragPreview. */
	beginTrackDragPreview(paintIds: Iterable<string>): void {
		if (this.documentType !== 'board' || !this.scene) {
			return;
		}
		const ids = new Set(paintIds);
		if (ids.size === 0) {
			return;
		}
		// A track committed through the incremental path is still drawn from
		// committedTrackOverlay, not the static buffer. Moving it again must
		// remove that old overlay entry rather than forcing a full rebuild just
		// because it has no static GPU range yet.
		const overlayTrackIds = new Set<string>();
		this.committedTrackOverlay = this.committedTrackOverlay.filter(item => {
			const owner = [...ids].find(id => item.id === id || item.id.startsWith(`${ id }:`));
			if (!owner) return true;
			overlayTrackIds.add(owner);
			return false;
		});
		const staticIds = new Set([...ids].filter(id => !overlayTrackIds.has(id)));
		const hiddenInPlace = staticIds.size === 0 || !!this.webglRenderer?.setStaticItemsVisible?.(staticIds, false);
		this.painter.removeItemsByIds(this.scene, ids);
		for (const id of ids) {
			this.hiddenTrackDragIds.add(id);
		}
		if (!hiddenInPlace) {
			this.geometryDirty = true;
		}
		this.scheduleRender();
	}

	/** Ends an active track-body drag-preview. A full board scene rebuild
	 *  (commitAstMutation's own path) always naturally restores whatever
	 *  beginTrackDragPreview hid, since removeItemsByIds only ever mutated
	 *  the in-memory scene, never the AST — this covers BOTH the "drag
	 *  committed" case (dragTrackLine already queued its own rebuild; the
	 *  fresh scene reflects the new segments, not the hidden old ones
	 *  either way) and the "plain click, nothing moved" case (nothing else
	 *  would otherwise trigger a rebuild, so the hidden originals would
	 *  otherwise just stay gone). Safe to call with nothing hidden (no-op),
	 *  matching endBoardDragPreview's contract. */
	endTrackDragPreview(): void {
		if (this.hiddenTrackDragIds.size === 0) {
			return;
		}
		this.hiddenTrackDragIds.clear();
		this.boardStructureDirty = true;
		this.scheduleRender();
	}

	/** Full-board ratsnest recompute — the safety net a drag's own
	 *  incremental refreshRatsnestForFootprints() shouldn't normally need,
	 *  but structural edits (delete/route/zone edit/...) already get one for
	 *  free via boardStructureDirty's full rebuild above; this is for
	 *  callers that want to force a fresh whole-board resync explicitly. */
	refreshBoardRatsnest(): void {
		if (this.documentType !== 'board' || !this.scene) {
			return;
		}
		this.ratsnestLines = buildBoardRatsnest(this.scene);
		this.lastRatsnestCommitSignature = null;
		this.scheduleRender();
	}

	/** Per-zone fill provenance — purely session/UI bookkeeping (e.g. a
	 *  future "modified" indicator or gating "Clear Fill"); BoardPainter
	 *  needs none of this, since a live-computed fill is written straight
	 *  into the zone's own `filled_polygons` AST field (via
	 *  KicadElementZone.setFilledPolygons — see KicadElementZone.ts's Phase
	 *  3 setters), the exact field BoardPainter.buildZone already reads for
	 *  an imported fill. Keyed by zone uuid; a zone never appearing here
	 *  reads as 'imported' (whatever the file itself carried). */
	protected zoneFillState = new Map<string, 'imported' | 'live' | 'cleared'>();

	/** Accepts either a bare zone uuid (callers with a real zone reference
	 *  already in hand, e.g. fillZone) or a zone hit-test paint id — BoardPainter.buildZone
	 *  gives every zone's outline/fill PaintedItems a composite id
	 *  (`${zoneUuid}:${layer}:outline` / `:fill:${idx}`) so per-layer/per-fill
	 *  items stay unique, but a UUID itself never contains a colon, so
	 *  stripping everything from the first ':' recovers the real uuid either
	 *  way. Without this, double-click-to-edit (which hands this method the
	 *  raw HitResult.id) could never resolve a zone at all. */
	protected findZoneByUuid(uuid: string): KicadElementZone | null {
		if (this.documentType !== 'board' || !this.boardRoot?.rootElement) {
			return null;
		}
		const bareUuid = uuid.includes(':') ? uuid.slice(0, uuid.indexOf(':')) : uuid;
		const zones = this.boardRoot.rootElement.findChildrenByClass(KicadElementZone) as KicadElementZone[];
		return zones.find(zone => zone.getUuid() === bareUuid) ?? null;
	}

	/** The point editor is deliberately shared by graphic polygons, copper
	 * zones, and rule areas. Their storage differs, but all expose one closed
	 * ring of editable points. */
	private findBoardPolygonByPaintId(paintId: string): {
		id: string; points: { x: number; y: number }[];
		setPoints(points: { x: number; y: number }[]): void;
	} | null {
		const zone = this.findZoneByUuid(paintId);
		if (zone) {
			return {
				id: zone.getUuid() ?? paintId,
				points: zone.getPolygon(),
				setPoints: points => zone.setPolygon(points)
			};
		}
		if (this.documentType !== 'board' || !this.boardRoot?.rootElement) {
			return null;
		}
		const polygon = (this.boardRoot.rootElement.findChildrenByClass(KicadElementGrPoly) as KicadElementGrPoly[])
			.find(item => item.getUuid() === paintId);
		if (!polygon) {
			return null;
		}
		return {
			id: polygon.getUuid() ?? paintId,
			points: polygon.getPoints(),
			setPoints: points => polygon.setPoints(points)
		};
	}

	/** Mirrors findZoneByUuid's bare-uuid recovery — buildGrPoly's own paint
	 *  id is already bare (no composite `:layer:part` suffix, unlike a
	 *  zone's), but stripping defensively costs nothing and keeps this
	 *  resolver consistent with every other paint-id lookup in this file. */
	protected findGrPolyByUuid(uuid: string): KicadElementGrPoly | null {
		if (this.documentType !== 'board' || !this.boardRoot?.rootElement) {
			return null;
		}
		const bareUuid = uuid.includes(':') ? uuid.slice(0, uuid.indexOf(':')) : uuid;
		const polygons = this.boardRoot.rootElement.findChildrenByClass(KicadElementGrPoly) as KicadElementGrPoly[];
		return polygons.find(polygon => polygon.getUuid() === bareUuid) ?? null;
	}

	/** Reads an existing graphic polygon into the Polygon Properties dialog's
	 *  draft shape — see PolygonDraft's own doc comment for what's covered. */
	getPolygonDraft(paintId: string): PolygonDraft | null {
		const polygon = this.findGrPolyByUuid(paintId);
		if (!polygon) {
			return null;
		}
		const stroke = polygon.getStroke();
		return {
			layer: polygon.getLayer(),
			lineWidthMm: stroke.width,
			lineStyle: stroke.type,
			fillMode: polygon.getFillMode(),
			locked: polygon.isLocked(),
			netName: polygon.getNetName() ?? ''
		};
	}

	private applyPolygonDraft(polygon: KicadElementGrPoly, draft: PolygonDraft): void {
		polygon.setStroke(draft.lineWidthMm, draft.lineStyle);
		polygon.setFillMode(draft.fillMode);
		polygon.setLocked(draft.locked);
		polygon.setLayer(draft.layer);
		polygon.setNetName(draft.netName || null);
	}

	/** Commits a freshly click-drawn outline as a new graphic polygon — the
	 *  polygon-tool gesture's points, plus whatever the Polygon Properties
	 *  dialog's OK button gathered. Field order matches real KiCad's own
	 *  writer (pts, stroke, fill, locked, layer, net, uuid — see
	 *  PolygonDraft's doc comment), so setPoints/setStroke/applyPolygonDraft
	 *  run before setUuid deliberately. */
	createPolygonFromOutline(points: readonly { x: number; y: number }[], draft: PolygonDraft): string | null {
		if (!this.canAddBoardGraphic() || points.length < 3) {
			return null;
		}
		this.pushUndoSnapshot('Draw polygon');
		const polygon = new KicadElementGrPoly();
		polygon.setPoints(points.map(point => ({ x: point.x, y: point.y })));
		this.applyPolygonDraft(polygon, draft);
		polygon.setUuid();
		this.boardRoot!.rootElement.addChild(polygon);
		this.commitAstMutation();
		return polygon.getUuid() ?? null;
	}

	/** Re-applies every Polygon Properties field to an already-placed graphic
	 *  polygon (double-click edit) — outline geometry is untouched. */
	updatePolygonProperties(paintId: string, draft: PolygonDraft): boolean {
		const polygon = this.findGrPolyByUuid(paintId);
		if (!polygon) {
			return false;
		}
		this.pushUndoSnapshot('Edit polygon properties');
		this.applyPolygonDraft(polygon, draft);
		if (!polygon.getUuid()) {
			polygon.setUuid();
		}
		this.commitAstMutation();
		return true;
	}

	/** Every board-wide rule area whose `(keepout (copperpour not_allowed))`
	 *  forbids other zones from pouring into it — the plain-data shape
	 *  BoardZoneFill's buildEdgeExclusionsByLayer needs, gathered here
	 *  (rather than inside BoardZoneFill.ts) since it's the one place that
	 *  already has live KicadElementZone access. Applies board-wide: even a
	 *  keepout that isn't itself being (re)filled still excludes other
	 *  zones' pours (real KiCad: "the exclusion is by outline rather than
	 *  filled area", zone_filler.cpp), so callers pass every zone on the
	 *  board, not just the ones being filled this call. */
	private keepoutZoneInputs(allZones?: readonly KicadElementZone[]): KeepoutZoneInput[] {
		const zones = allZones ?? (this.boardRoot?.rootElement.findChildrenByClass(
			KicadElementZone) as KicadElementZone[] ?? []);
		return zones
			.filter(zone => zone.isRuleArea() && zone.getDoNotAllowZoneFills() && zone.getPolygon().length >= 3)
			.map(zone => ({ outlinePoints: zone.getPolygon(), layers: zone.getLayers() }));
	}

	/** Real KiCad zones aren't required to carry a `(uuid ...)` child (see
	 *  fillAllZones' own comment on the same gap) — a WeakMap keyed by the
	 *  live zone OBJECT (not a per-call array index) guarantees the SAME
	 *  zone always gets the SAME fallback id across every call this
	 *  session, regardless of which enumeration (all zones vs. just the
	 *  ones being filled this call) or index produced it. That stability
	 *  matters here specifically because buildZonePriorityKnockouts
	 *  matches "is this the zone I'm filling, or a different one" purely
	 *  by this id string — two DIFFERENT zones colliding on the same id
	 *  (impossible with this scheme) would wrongly treat them as the same
	 *  zone; the same zone getting two DIFFERENT ids across two call sites
	 *  (the actual risk with a naive per-call `_zonefill_${i}` scheme)
	 *  would make it invisible to its own peer-list lookup. */
	private static readonly zoneFallbackIds = new WeakMap<KicadElementZone, string>();
	private static zoneFallbackIdCounter = 0;
	private zoneJobId(zone: KicadElementZone): string {
		const real = zone.getUuid();
		if (real) {
			return real;
		}
		let id = KicadRenderSession.zoneFallbackIds.get(zone);
		if (!id) {
			id = `__zonefill_${ KicadRenderSession.zoneFallbackIdCounter++ }`;
			KicadRenderSession.zoneFallbackIds.set(zone, id);
		}
		return id;
	}

	/** Every OTHER fillable (non-rule-area) zone on the board, in the plain
	 *  shape BoardZoneFill's buildZonePriorityKnockouts needs to resolve
	 *  overlapping-zone priority — see that function's own doc comment.
	 *  Mirrors keepoutZoneInputs' own pattern (board-wide by default, but a
	 *  caller that already enumerated every zone this call — fillAllZones —
	 *  can pass it in to avoid walking the AST twice). */
	private zonePriorityInputs(allZones?: readonly KicadElementZone[]): OtherZoneInput[] {
		const zones = allZones ?? (this.boardRoot?.rootElement.findChildrenByClass(
			KicadElementZone) as KicadElementZone[] ?? []);
		return zones
			.filter(zone => !zone.isRuleArea() && zone.getPolygon().length >= 3)
			.map(zone => ({
				uuid: this.zoneJobId(zone),
				netId: zone.getNetId(),
				priority: zone.getPriority(),
				layers: zone.getLayers(),
				outlinePoints: zone.getPolygon(),
				clearanceMm: zone.getClearance(),
			}));
	}

	/** A copper zone's Pad Connections field (Thermal reliefs/Solid/Thru-hole
	 *  only/None), plus the thermal-relief sizing BoardZoneFill's
	 *  collectExclusionRingsMm needs to act on it — see that file's "Pad
	 *  Connections" header comment for the real-KiCad source this mirrors. */
	private zonePadConnectionSettings(zone: KicadElementZone) {
		const thermal = zone.getThermalRelief();
		return {
			mode: zone.getPadConnectionType(),
			thermalGapMm: thermal.gapMm,
			thermalSpokeWidthMm: thermal.spokeWidthMm,
			minThicknessMm: zone.getMinThickness()
		};
	}

	/**
	 * Computes and writes a zone's fill for every copper layer it pours
	 * onto — BoardZoneFill's ported zone_filler.cpp pipeline against
	 * `this.scene`'s already-built pad/via/track geometry, so this only
	 * needs a scene that's already up to date (no special build-order
	 * requirement: the fill computation runs AFTER a full scene exists, not
	 * interleaved with building one).
	 *
	 * The actual Clipper2 boolean-op work is genuinely slow enough to
	 * freeze the UI for several seconds on a board with a few zones and a
	 * lot of copper to route around, so it doesn't run on this thread —
	 * `runJobs` is the caller's off-main-thread executor (apps/kicad-viewer's
	 * zoneFillClient.ts, a Web Worker wrapper); this method only gathers the
	 * plain job data and applies the results, exactly mirroring how
	 * BoardZoneFill.ts itself splits "read the live scene" (main-thread-only)
	 * from "run Clipper2" (worker-safe) — kicad-render stays decoupled from
	 * the app's own worker/bundler setup, matching how e.g.
	 * registerKicadIoClasses keeps this package decoupled from @kicad-io.
	 */
	async fillZone(
		zoneUuid: string, runJobs: ZoneFillExecutor, onProgress?: (done: number, total: number) => void,
		designSettings?: ZoneFillDesignSettings
	): Promise<boolean> {
		if (this.documentType !== 'board' || !this.boardRoot?.rootElement || !this.scene) {
			return false;
		}
		const zone = this.findZoneByUuid(zoneUuid);
		// Rule areas ("keepouts") are never filled — real KiCad's own
		// zone_filler.cpp skips them before ever building a fill job for
		// them ("Rule areas are not filled").
		if (!zone || zone.isRuleArea()) {
			return false;
		}
		const outline = zone.getPolygon();
		if (outline.length < 3) {
			return false;
		}
		const boardOutlineNm = buildBoardOutlineRegionNm(this.boardRoot);
		const copperLayers = resolveCopperLayers(this.scene);
		const extraExclusionsByLayer = buildEdgeExclusionsByLayer(
			this.boardRoot, copperLayers, this.keepoutZoneInputs(), designSettings?.copperEdgeClearanceMm
		);
		const jobs = buildZoneFillJobs(
			[
				{
					uuid: zoneUuid,
					outlinePoints: outline,
					netId: zone.getNetId(),
					layers: zone.getLayers(),
					clearanceMm: resolveZoneClearanceMm(zone, designSettings),
					priority: zone.getPriority(),
					padConnection: this.zonePadConnectionSettings(zone),
					islandRemoval: zone.getIslandRemovalMode()
				}
			],
			this.scene, boardOutlineNm, extraExclusionsByLayer, this.zonePriorityInputs()
		);
		const results = await runJobs(jobs, onProgress);

		// Re-validate after the await — the board could have been closed or
		// swapped out for a different one while the worker was running.
		if (this.documentType !== 'board' || !this.boardRoot?.rootElement || this.findZoneByUuid(zoneUuid) !== zone) {
			return false;
		}
		const fill = results.filter(r => r.zoneUuid === zoneUuid).map(r => ({ layer: r.layer, points: r.points }));
		this.pushUndoSnapshot('Fill zone');
		zone.setFilledPolygons(fill);
		zone.setFilled(fill.length > 0);
		this.zoneFillState.set(zoneUuid, 'live');
		this.commitAstMutation();
		return true;
	}

	clearZoneFill(zoneUuid: string): boolean {
		if (this.documentType !== 'board' || !this.boardRoot?.rootElement) {
			return false;
		}
		const zone = this.findZoneByUuid(zoneUuid);
		if (!zone) {
			return false;
		}
		this.pushUndoSnapshot('Clear zone fill');
		zone.setFilledPolygons([]);
		zone.setFilled(false);
		this.zoneFillState.set(zoneUuid, 'cleared');
		this.commitAstMutation();
		return true;
	}

	/** Every field the Copper Zone Properties dialog collects — one draft
	 *  object shared by both "draw a new zone" and "edit an existing one",
	 *  applied via the exact same KicadElementZone setters either way
	 *  (applyZoneDraft below) so the two flows can't drift apart. netId 0
	 *  is real KiCad's own "<no net>" floating-copper-pour representation,
	 *  not a sentinel this app invented. */
	getBoardNets(): { id: number; name: string }[] {
		if (this.documentType !== 'board' || !this.boardRoot?.rootElement) {
			return [];
		}
		return (this.boardRoot.rootElement.findChildrenByClass(KicadElementNet) as KicadElementNet[])
			.map(net => ({ id: net.id, name: net.netName ?? '' }))
			.sort((a, b) => a.id - b.id);
	}

	/** Reads an existing zone's current values into the same ZoneDraft shape
	 *  createZoneFromOutline/updateZoneProperties consume — the Copper Zone
	 *  Properties dialog's "edit" path pre-fills its fields from this
	 *  instead of the dialog inventing its own defaults for an
	 *  already-placed zone. */
	getZoneDraft(paintId: string): ZoneDraft | null {
		const zone = this.findZoneByUuid(paintId);
		if (!zone) {
			return null;
		}
		const hatch = zone.getHatch();
		const pad = zone.getThermalRelief();
		const smoothing = zone.getCornerSmoothing();
		const island = zone.getIslandRemovalMode();
		return {
			layers: zone.getLayers(),
			netId: zone.getNetId() ?? 0,
			netName: zone.getNetName() ?? '',
			name: zone.getZoneName(),
			locked: zone.isLocked(),
			clearanceMm: zone.getClearance(),
			minThicknessMm: zone.getMinThickness(),
			padConnection: zone.getPadConnectionType(),
			thermalGapMm: pad.gapMm,
			thermalSpokeWidthMm: pad.spokeWidthMm,
			cornerSmoothing: smoothing.type,
			cornerRadiusMm: smoothing.radiusMm,
			islandRemoval: island.mode,
			islandAreaMinMm: island.areaMinMm,
			priority: zone.getPriority(),
			hatchStyle: hatch.style,
			hatchPitchMm: hatch.pitchMm
		};
	}

	private applyZoneDraft(zone: KicadElementZone, draft: ZoneDraft): void {
		zone.setLayers(draft.layers);
		zone.setNet(draft.netId, draft.netName);
		zone.setZoneName(draft.name);
		zone.setLocked(draft.locked);
		zone.setClearance(draft.clearanceMm);
		zone.setMinThickness(draft.minThicknessMm);
		zone.setPadConnectionType(draft.padConnection);
		zone.setThermalRelief(draft.thermalGapMm, draft.thermalSpokeWidthMm);
		zone.setCornerSmoothing(draft.cornerSmoothing, draft.cornerRadiusMm);
		zone.setIslandRemovalMode(draft.islandRemoval, draft.islandAreaMinMm);
		zone.setPriority(draft.priority);
		zone.setHatch(draft.hatchStyle, draft.hatchPitchMm);
	}

	/** Commits a freshly click-drawn outline as a new copper zone — the
	 *  polygon a zone-tool gesture collected, plus whatever the Copper Zone
	 *  Properties dialog's OK button gathered. Caller still owns actually
	 *  computing the fill (fillZone) once this returns a uuid — creating the
	 *  zone and running Clipper2 against it are kept separate exactly like
	 *  every other zone-fill entry point (fillZone/fillAllZones) already
	 *  does, since the fill is the slow, worker-hosted half. */
	createZoneFromOutline(points: readonly { x: number; y: number }[], draft: ZoneDraft): string | null {
		if (!this.canAddBoardGraphic() || points.length < 3 || draft.layers.length === 0) {
			return null;
		}
		this.pushUndoSnapshot('Draw zone');
		const zone = new KicadElementZone();
		this.applyZoneDraft(zone, draft);
		zone.setUuid();
		// Polygon comes after the zone settings in KiCad's canonical writer
		// order. More importantly, setPolygon guarantees the grammar-bearing
		// `(polygon (pts ...))` wrapper rather than an anonymous group.
		zone.setPolygon(points.map(point => ({ x: point.x, y: point.y })));
		this.boardRoot!.rootElement.addChild(zone);
		this.commitAstMutation();
		return zone.getUuid() ?? null;
	}

	/** Re-applies every Copper Zone Properties field to an already-placed
	 *  zone (the dialog's "edit" path, reached by double-clicking an
	 *  existing zone) — outline geometry is untouched. Real KiCad boards
	 *  aren't required to carry a zone uuid (see fillAllZones' own doc
	 *  comment on the same gap); an edit is the natural moment to backfill
	 *  one so this zone has a stable, collision-free fillZone() key from
	 *  here on. */
	updateZoneProperties(paintId: string, draft: ZoneDraft): boolean {
		if (this.documentType !== 'board' || !this.boardRoot?.rootElement) {
			return false;
		}
		const zone = this.findZoneByUuid(paintId);
		if (!zone) {
			return false;
		}
		this.pushUndoSnapshot('Edit zone properties');
		this.applyZoneDraft(zone, draft);
		if (!zone.getUuid()) {
			zone.setUuid();
		}
		this.commitAstMutation();
		return true;
	}

	/** Reads an existing PCB rule area into the same draft shape used by its
	 * draw and edit dialogs. Rule areas are zones with a `(keepout ...)`
	 * child, so their outline editing remains shared with copper zones. */
	getRuleAreaDraft(paintId: string): RuleAreaDraft | null {
		const zone = this.findZoneByUuid(paintId);
		if (!zone?.isRuleArea()) {
			return null;
		}
		const hatch = zone.getHatch();
		return {
			layers: zone.getLayers(), name: zone.getZoneName(), locked: zone.isLocked(),
			hatchStyle: hatch.style, hatchPitchMm: hatch.pitchMm,
			keepout: zone.getKeepoutSettings()
		};
	}

	private applyRuleAreaDraft(zone: KicadElementZone, draft: RuleAreaDraft): void {
		zone.setLayers(draft.layers);
		zone.setZoneName(draft.name);
		zone.setLocked(draft.locked);
		zone.setHatch(draft.hatchStyle, draft.hatchPitchMm);
		zone.setKeepoutSettings(draft.keepout);
	}

	createRuleAreaFromOutline(points: readonly { x: number; y: number }[], draft: RuleAreaDraft): string | null {
		if (!this.canAddBoardGraphic() || points.length < 3 || draft.layers.length === 0) {
			return null;
		}
		this.pushUndoSnapshot('Draw rule area');
		const zone = new KicadElementZone();
		this.applyRuleAreaDraft(zone, draft);
		zone.setUuid();
		zone.setPolygon(points.map(point => ({ x: point.x, y: point.y })));
		this.boardRoot!.rootElement.addChild(zone);
		this.commitAstMutation();
		return zone.getUuid() ?? null;
	}

	updateRuleAreaProperties(paintId: string, draft: RuleAreaDraft): boolean {
		if (this.documentType !== 'board' || !this.boardRoot?.rootElement) {
			return false;
		}
		const zone = this.findZoneByUuid(paintId);
		if (!zone?.isRuleArea()) {
			return false;
		}
		this.pushUndoSnapshot('Edit rule area properties');
		this.applyRuleAreaDraft(zone, draft);
		if (!zone.getUuid()) {
			zone.setUuid();
		}
		this.commitAstMutation();
		return true;
	}

	/** Corner + edge-midpoint anchors for each editable PCB closed polygon:
	 *  graphics, copper zones, and rule areas. Drawn whenever one is selected
	 *  in Edit mode, and hit-tested by BoardPointerController to start a
	 *  corner-move or edge-parallel-drag gesture — mirrors real KiCad's
	 *  PCB_POINT_EDITOR (pcb_point_editor.cpp) zone-outline behavior: a
	 *  square handle at each existing vertex (drag moves just that vertex),
	 *  a round handle at each edge midpoint (drag shifts BOTH that edge's
	 *  endpoints by the same delta, sliding the whole edge sideways in
	 *  parallel — real KiCad's EDIT_LINE::SetPosition; it does NOT insert a
	 *  new corner — that's a separate "Create Corner" board context-menu
	 *  action, see nearestBoardPolygonInsertion/insertBoardPolygonPoint).
	 *  `midpoints[i]` sits between `corners[i]` and
	 *  `corners[(i+1) % corners.length]` — the outline is always implicitly
	 *  closed, same as its rendered outline. */
	getBoardPolygonAnchors(paintId: string): { id: string; corners: Vec2[]; midpoints: Vec2[] } | null {
		const polygon = this.findBoardPolygonByPaintId(paintId);
		const points = polygon?.points;
		if (!polygon || !points || points.length < 2) {
			return null;
		}
		const corners = points.map(point => new Vec2(point.x, point.y));
		const midpoints = points.map((point, index) => {
			const next = points[(index + 1) % points.length]!;
			return new Vec2((point.x + next.x) / 2, (point.y + next.y) / 2);
		});
		return { id: polygon.id, corners, midpoints };
	}

	/** Moves an existing PCB polygon vertex. The caller owns
	 *  the undo snapshot, pushed once at gesture start like every other
	 *  drag in this codebase — a whole drag is one undo step, not one per
	 *  mousemove frame. */
	moveBoardPolygonPoint(paintId: string, index: number, x: number, y: number): boolean {
		const polygon = this.findBoardPolygonByPaintId(paintId);
		if (!polygon || index < 0 || index >= polygon.points.length) {
			return false;
		}
		polygon.setPoints(
			polygon.points.map((point, pointIndex) => pointIndex === index ? { x, y } : { x: point.x, y: point.y }));
		this.commitAstMutation();
		return true;
	}

	/** Shifts an entire PCB polygon edge in parallel by (dx, dy). Mirrors real KiCad's
	 *  EDIT_LINE::SetPosition (include/tool/edit_points.h), which moves both
	 *  endpoints by the SAME delta rather than inserting anything. `dx`/`dy`
	 *  is the delta from the edge's current position (this frame's move
	 *  minus last frame's, not from the drag's original start point), so
	 *  repeated calls across one drag gesture accumulate correctly —
	 *  matches translateBoardSelection's identical per-frame-delta
	 *  convention (moveBoardPolygonPoint instead takes an absolute
	 *  position, since a corner just snaps straight to the cursor).
	 *  `edgeIndex` is the edge between
	 *  points[edgeIndex] and points[(edgeIndex+1) % length]. */
	moveBoardPolygonEdge(paintId: string, edgeIndex: number, dx: number, dy: number): boolean {
		const polygon = this.findBoardPolygonByPaintId(paintId);
		if (!polygon || edgeIndex < 0 || edgeIndex >= polygon.points.length) {
			return false;
		}
		const nextIndex = (edgeIndex + 1) % polygon.points.length;
		polygon.setPoints(polygon.points.map((point, index) => (index === edgeIndex || index === nextIndex)
			? { x: point.x + dx, y: point.y + dy } : { x: point.x, y: point.y }));
		this.commitAstMutation();
		return true;
	}

	/** Finds where a new corner belongs for the board context menu's
	 *  "Create Corner" action — the point closest to (x, y) on any polygon
	 *  EDGES (a projection onto that segment, not the nearest existing
	 *  vertex), plus which edge it landed on. Mirrors real KiCad's
	 *  PCB_POINT_EDITOR::addCorner (pcb_point_editor.cpp): scan every
	 *  segment, keep the nearest, project the cursor onto it. Pass the
	 *  result straight to insertBoardPolygonPoint. */
	nearestBoardPolygonInsertion(paintId: string, x: number, y: number): {
		edgeIndex: number;
		x: number;
		y: number
	} | null {
		const polygon = this.findBoardPolygonByPaintId(paintId);
		const points = polygon?.points;
		if (!polygon || !points || points.length < 2) {
			return null;
		}
		let best: { edgeIndex: number; x: number; y: number; distSq: number } | null = null;
		for (let index = 0; index < points.length; index++) {
			const a = points[index]!;
			const b = points[(index + 1) % points.length]!;
			const dx = b.x - a.x, dy = b.y - a.y;
			const lengthSq = dx * dx + dy * dy;
			const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSq)) : 0;
			const px = a.x + t * dx, py = a.y + t * dy;
			const distSq = (x - px) ** 2 + (y - py) ** 2;
			if (!best || distSq < best.distSq) {
				best = { edgeIndex: index, x: px, y: py, distSq };
			}
		}
		return best ? { edgeIndex: best.edgeIndex, x: best.x, y: best.y } : null;
	}

	/** Inserts a new PCB polygon vertex on the edge right after
	 *  `afterIndex` (0-based — the edge between points[afterIndex] and
	 *  points[afterIndex+1], wrapping for the closing edge) — the "Create
	 *  Corner" board context-menu action's mutation half; call
	 *  nearestBoardPolygonInsertion first to get afterIndex/x/y. Returns the
	 *  new vertex's index. */
	insertBoardPolygonPoint(paintId: string, afterIndex: number, x: number, y: number): number | null {
		const polygon = this.findBoardPolygonByPaintId(paintId);
		const points = polygon?.points;
		if (!polygon || !points || afterIndex < 0 || afterIndex >= points.length) {
			return null;
		}
		const insertIndex = afterIndex + 1;
		const next = points.map(point => ({ x: point.x, y: point.y }));
		next.splice(insertIndex, 0, { x, y });
		polygon.setPoints(next);
		this.commitAstMutation();
		return insertIndex;
	}

	/** Fills every zone on the board in one undo step (one worker run
	 *  covering every zone's jobs, so progress reflects the whole board, not
	 *  one zone at a time). Returns the count actually filled (zones with
	 *  fewer than 3 outline points are skipped, same guard as fillZone). */
	async fillAllZones(
		runJobs: ZoneFillExecutor, onProgress?: (done: number, total: number) => void,
		designSettings?: ZoneFillDesignSettings
	): Promise<number> {
		if (this.documentType !== 'board' || !this.boardRoot?.rootElement || !this.scene) {
			return 0;
		}
		const zones = this.boardRoot.rootElement.findChildrenByClass(KicadElementZone) as KicadElementZone[];
		// Rule areas ("keepouts") are never filled themselves — see fillZone's
		// comment — they only ever act as exclusions for OTHER zones' fills.
		const fillable = zones.filter(zone => !zone.isRuleArea() && zone.getPolygon().length >= 3);
		if (fillable.length === 0) {
			return 0;
		}
		const boardOutlineNm = buildBoardOutlineRegionNm(this.boardRoot);
		const copperLayers = resolveCopperLayers(this.scene);
		const extraExclusionsByLayer = buildEdgeExclusionsByLayer(
			this.boardRoot, copperLayers, this.keepoutZoneInputs(zones), designSettings?.copperEdgeClearanceMm
		);
		// Real KiCad zones aren't required to carry a (uuid ...) child — it's
		// an optional field many exported boards omit — so `getUuid()` alone
		// isn't a safe job tag here. zoneJobId's WeakMap-backed fallback (not
		// a per-call array index) is used for the duration of the fill-job/
		// result-regrouping below so it stays consistent with
		// zonePriorityInputs' own id for the same zone object (see
		// zoneJobId's doc comment for why that consistency matters); it's
		// never written back onto the zone (setUuid is never called).
		const jobIds = fillable.map(zone => this.zoneJobId(zone));
		const zoneInputs = fillable.map((zone, i) => ({
			uuid: jobIds[i], outlinePoints: zone.getPolygon(), netId: zone.getNetId(),
			layers: zone.getLayers(), clearanceMm: resolveZoneClearanceMm(zone, designSettings),
			priority: zone.getPriority(),
			padConnection: this.zonePadConnectionSettings(zone),
			islandRemoval: zone.getIslandRemovalMode()
		}));
		const jobs = buildZoneFillJobs(
			zoneInputs, this.scene, boardOutlineNm, extraExclusionsByLayer, this.zonePriorityInputs(zones));
		const results = await runJobs(jobs, onProgress);

		if (this.documentType !== 'board' || !this.boardRoot?.rootElement) {
			return 0;
		}
		const resultsByZone = new Map<string, { layer: string; points: MmPath }[]>();
		for (const r of results) {
			if (!resultsByZone.has(r.zoneUuid)) {
				resultsByZone.set(r.zoneUuid, []);
			}
			resultsByZone.get(r.zoneUuid)!.push({ layer: r.layer, points: r.points });
		}

		this.pushUndoSnapshot('Fill all zones');
		let filledCount = 0;
		for (let i = 0; i < fillable.length; i++) {
			const zone = fillable[i];
			const fill = resultsByZone.get(jobIds[i]) ?? [];
			zone.setFilledPolygons(fill);
			zone.setFilled(fill.length > 0);
			const uuid = zone.getUuid();
			if (uuid) {
				this.zoneFillState.set(uuid, 'live');
			}
			filledCount++;
		}
		this.commitAstMutation();
		return filledCount;
	}

	/** Clears every zone's fill in one undo step (real KiCad's "Clear All
	 *  Zone Fills" Edit-menu action). */
	clearAllZoneFills(): number {
		if (this.documentType !== 'board' || !this.boardRoot?.rootElement) {
			return 0;
		}
		const zones = this.boardRoot.rootElement.findChildrenByClass(KicadElementZone) as KicadElementZone[];
		if (zones.length === 0) {
			return 0;
		}
		this.pushUndoSnapshot('Clear all zone fills');
		for (const zone of zones) {
			zone.setFilledPolygons([]);
			zone.setFilled(false);
			const uuid = zone.getUuid();
			if (uuid) {
				this.zoneFillState.set(uuid, 'cleared');
			}
		}
		this.commitAstMutation();
		return zones.length;
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
			SessionState.beginBatch(this);
		}

		private endBatch(): void {
			SessionState.endBatch(this);
		}

	/** Push the current schematic text onto the undo stack. Called internally
	 *  as the first line of every one-shot mutation (addWire, deleteElements,
	 *  …) — impossible to forget. Continuous drag methods (moveSymbolByRef,
	 *  translateElementById, …) do NOT call this themselves (would flood the
	 *  stack every mousemove) — the caller pushes once at gesture start. */
	pushUndoSnapshot(label = 'Edit'): void {
			SessionState.pushUndoSnapshot(this, label);
		}

	/** Clears both stacks — call on file load, never push (undo must not step
	 *  into an unrelated previously-opened file's content). */
	resetUndoHistory(): void {
			SessionState.clearUndoRedo(this);
		}

	get canUndo(): boolean {
			return SessionState.canUndo(this);
	}

	get canRedo(): boolean {
			return SessionState.canRedo(this);
	}

	/** Compact history data for an editor/debug sidebar. */
	getUndoStackDebug(): { undoDepth: number; redoDepth: number; undo: { label: string; bytes: number }[] } {
			return SessionState.getUndoStackDebug(this);
		}

	async undo(): Promise<boolean> {
			return SessionState.undo(this);
		}

	async redo(): Promise<boolean> {
			return SessionState.redo(this);
		}

	/**
	 * Restores and discards the most recent undo snapshot without creating a
	 * redo entry.  Interactive tools use this for Escape: cancelling a move
	 * must leave the document and its history exactly as they were before the
	 * tool was entered, rather than making the cancelled placement redoable.
	 */
	async cancelLatestUndoSnapshot(): Promise<boolean> {
			return SessionState.cancelLatestUndoSnapshot(this);
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
		// (lib_name "X") overrides the lib_symbols lookup key when present —
		// see SchematicPainter.buildSymbolInstance's identical fix for why.
		const libLookupName = instance.getLibName?.() ?? libId;
		return (libLookupName && libSymbols ? libSymbols.findSymbolByName(libLookupName) : null) ?? null;
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
		const isSchematic = this.documentType === 'schematic';
		if (isSchematic && (!this.schematicRoot || !this.schScene)) {
			return false;
		}
		if (!isSchematic && this.documentType !== 'board') {
			return false;
		}
		if (!isSchematic && (!this.boardRoot || !this.scene)) {
			return false;
		}
		const hitTestItems = isSchematic ? this.schScene!.hitTestItems : this.scene!.hitTestItems;
		const item = hitTestItems.find(it => it.id === paintId);
		if (!item?.element) {
			return false;
		}
		this.pushUndoSnapshot('Property edit');
		mutate(item.element);
		this.commitAstMutation();
		return true;
	}

	/** Read-only lock check for a board hit item — BoardPointerController
	 *  calls this before committing to a drag gesture (Override locks
	 *  toolbar checkbox). Duck-typed `isLocked` rather than a class check
	 *  since Footprint/Zone/Via/Segment/TrackArc each implement it via
	 *  their own mixin/copy but share no common lockable base; anything
	 *  else (graphics, text, zones without geometry) simply isn't locked. */
	isBoardElementLocked(paintId: string): boolean {
		if (this.documentType !== 'board' || !this.boardRoot || !this.scene) {
			return false;
		}
		const element = this.scene.hitTestItems.find(it => it.id === paintId)?.element as {
			isLocked?(): boolean
		} | undefined;
		return !!element?.isLocked?.();
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
	 * UI refresh). Dual-mode via activeRoot/activeScene (schematic OR
	 * board) — e.g. the board context menu's Lock/Unlock action on a
	 * multi-selection.
	 */
	mutateElementsByPaintIds(ids: string[], mutate: (element: any) => void): number {
		if (!this.activeRoot || !this.activeScene) {
			return 0;
		}
		const elements: any[] = [];
		for (const id of ids) {
			const el = this.activeScene.hitTestItems.find(it => it.id === id)?.element;
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
		if (!(pin instanceof KicadElementPin) || !(pin.parent instanceof KicadElementSheet) || typeof pin.setOrigin
			!== 'function') {
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
			{ side: 'left', dist: distanceToSegment(x, y, left, bottom, left, top) }
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
		const item = items.find(it => it.id === paintId || it.id.startsWith(`${ paintId }:`));
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
				rotation: Number(origin?.rotation ?? 0)
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
			rotation: Number(origin?.rotation ?? 0)
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
		const trailingIndex = root.children.findIndex(
			(c: any) => c.name === 'sheet_instances' || c.name === 'embedded_files');
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
		makeEl: () => {
			setPoints(pts: { x: number; y: number }[]): void;
			setStroke(w: number, t: 'default'): void;
			setUuid(u?: string): void;
			getUuid(): string | undefined
		},
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
			const labels = (this.schScene.layerBuckets.get('Labels') ?? []).filter(
				it => it.kind === 'label' && it.hitTestable);
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
		if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1) {
			return null;
		}
		const table = new KicadElementTable();
		const cells = new (class extends KicadElementTableCell {
			override name = 'cells';
		})();
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
		if (this.documentType !== 'schematic' || !this.schematicRoot?.rootElement || points.length < 3) {
			return null;
		}
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
		if (!selectedId) {
			return null;
		}
		const scene = this.documentType === 'board' ? this.scene : this.schScene;
		if (!scene) {
			return null;
		}
		const item = scene.hitTestItems.find(it => it.id === selectedId);
		const el: any = item?.element;
		const boardTextBoxIsAxisAligned = el?.name === 'gr_text_box'
			&& Number(el.findFirstChildByName?.('angle')?.attributes?.[0]?.value ?? 0) === 0;
		const boardBarcodeIsAxisAligned = el?.name === 'barcode'
			&& Number(el.getOrigin?.().rotation ?? 0) === 0;
		const eligible = this.documentType === 'schematic'
			?
			(el?.name === 'rectangle' || el?.name === 'text_box' || el?.name === 'image') && item?.shape.type === 'rect'
			:
			(el?.name === 'gr_rect' || el?.name === 'image' || boardTextBoxIsAxisAligned || boardBarcodeIsAxisAligned);
		if (!item || !eligible) {
			return null;
		}
		if (boardBarcodeIsAxisAligned) {
			const origin = el.getOrigin();
			const size = el.getSize?.() ?? {};
			const width = Number(size.width);
			const height = Number(size.height);
			return width > 0 && height > 0
				? { id: item.id, x: origin.x - width / 2, y: origin.y - height / 2, width, height }
				: null;
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
					{ kind: 'circle-radius', x: center.x + radius, y: center.y }
				]
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
						{ kind: 'arc-center', x: geometry.centerX, y: geometry.centerY }
					]
				};
			}
			catch {
				return null;
			}
		}
		if (el.name === 'bezier' && typeof el.getPoints === 'function') {
			const points = el.getPoints();
			if (!Array.isArray(points) || points.length !== 4) {
				return null;
			}
			const kinds: CurveAnchor[] = ['bezier-start', 'bezier-control-1', 'bezier-control-2', 'bezier-end'];
			return {
				id: item.id, kind: 'bezier',
				anchors: points.map((point: { x: number; y: number }, index: number) => ({
					kind: kinds[index]!, x: point.x, y: point.y
				}))
			};
		}
		if (item.shape.type === 'polygon' && (el.name === 'polyline' || el.name === 'rule_area')) {
			const points = item.shape.points;
			return {
				id: item.id, kind: 'polygon',
				anchors: points.map((point, index) => ({
					kind: `polygon-vertex-${ index }` as CurveAnchor, x: point.x, y: point.y
				}))
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
	addDirectiveLabel(
		x: number, y: number, netclassName: string, shape: KicadDirectiveLabelShape = 'round',
		rotation = 0
	): string | null {
		const flag = new KicadElementNetclassFlag();
		flag.setOrigin(x, y, rotation);
		flag.setShape(shape);
		flag.setPinLength(2.54);
		flag.setFont(1.27, 1.27);
		flag.setJustify(KicadRenderSession.labelJustifyFor(rotation));
		flag.addChild(
			KicadElementSymbol.buildLibraryProperty('Netclass', netclassName, { x: x + 2.54, y: y - 1.27, rot: 0 }));
		return this.attachToSchematicRoot(flag);
	}

	/**
	 * Find (or build-and-insert) a power-symbol library definition in the
	 * schematic's lib_symbols block, keyed by libId. If lib_symbols itself is
	 * missing (rare — every file this app can open already has one, but don't
	 * assume it can't happen) a fresh one is inserted right after the
	 * schematic's header block (version/generator/generator_version/uuid/
	 * paper), not unshifted to the absolute front — real KiCad's own parser
	 * requires those header elements to be the FIRST children of `kicad_sch`
	 * (ParseSchematic's parseHeader() reads them positionally, before the
	 * general element loop even starts), so a bare unshift() landing
	 * lib_symbols ahead of them produces a file real KiCad rejects with a
	 * generic "Expecting '(' " parse error at the header's old line 3 —
	 * confirmed against a real exported project. Same class of bug as
	 * insertRootChild's sheet_instances/embedded_files fix, just at the
	 * opposite (leading) end of the file.
	 */
	/**
	 * Direct port of real KiCad's `LIB_SYMBOL::Flatten()` (lib_symbol.cpp):
	 * clone `base`'s full body (fields + graphics + pin sub-units) as-is,
	 * then overlay `derived`'s own field properties on top (replacing a
	 * same-named field, adding any the base didn't have), and finally stamp
	 * the derived symbol's own identity (`targetLibId`) onto the result. No
	 * `(extends ...)` is written — see addLibrarySymbolFromText's own doc
	 * comment for why a schematic-embedded lib_symbols entry can never use
	 * one. Sub-unit children (`"<Base>_<unit>_<style>"`) are renamed to the
	 * new symbol's own bare name so the written file matches the naming
	 * convention real KiCad's own writer produces after flattening.
	 */
	private flattenDerivedLibSymbol(
		base: KicadElementSymbol, derived: KicadElementSymbol, targetLibId: string
	): KicadElementSymbol {
		const flattened = parseText(base.write()) as KicadElementSymbol;
		flattened.symbolName = targetLibId;
		const bareLibName = targetLibId.includes(':') ? targetLibId.slice(targetLibId.indexOf(':') + 1) : targetLibId;
		for (const layer of flattened.getLayers()) {
			const { unit, deMorgan } = layer.deconstructSymbolName();
			layer.symbolName = `${ bareLibName }_${ unit }_${ deMorgan }`;
		}
		for (const prop of derived.getProperties()) {
			const existing = flattened.getPropertyByName(prop.propertyName!);
			const clone = parseText(prop.write()) as KicadElementProperty;
			clone.rootLevel = flattened.rootLevel + 1;
			clone.parent = flattened;
			if (existing) {
				const idx = flattened.children.indexOf(existing);
				flattened.children[idx] = clone;
			}
			else {
				flattened.children.push(clone);
			}
		}
		return flattened;
	}

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
			const headerNames = new Set(['version', 'generator', 'generator_version', 'uuid', 'paper']);
			let insertIndex = 0;
			for (const child of root.children) {
				if (!headerNames.has((child as any)?.name)) {
					break;
				}
				insertIndex++;
			}
			root.children.splice(insertIndex, 0, libSymbols);
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
			const parsed = parseText(sourceText);
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
			if (base) {
				graphicsSource = base;
			}
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
	addLibrarySymbolFromText(
		sourceText: string, symbolName: string, x: number, y: number, libIdOverride?: string, unit = 1,
		reuseReference?: string
	): string | null {
		if (this.documentType !== 'schematic' || !this.schematicRoot?.rootElement || !sourceText.trim()) {
			return null;
		}
		const parsed = parseText(sourceText);
		const candidates = parsed.name === 'symbol'
			? [parsed as KicadElementSymbol]
			: parsed.children.filter(child => child instanceof KicadElementSymbol) as KicadElementSymbol[];
		const source = candidates.find(symbol => symbol.symbolName === symbolName)
			?? candidates.find(symbol => symbol.symbolName?.endsWith(`:${ symbolName }`));
		if (!source) {
			return null;
		}

		const libId = libIdOverride ?? source.symbolName ?? symbolName;
		const sourceForClone = parseText(source.write()) as KicadElementSymbol;
		sourceForClone.symbolName = libId;
		let detached = parseText(sourceForClone.write()) as KicadElementSymbol;

		// A derived symbol (`(extends "Base")`) has no graphics/pins of its
		// own in the SOURCE library file, where that's fine — a real .kicad_sym
		// library file's parser (SCH_IO_KICAD_SEXPR_PARSER::ParseLib) keeps a
		// live map of every symbol parsed so far and resolves `extends`
		// against it. A SCHEMATIC file's OWN embedded `lib_symbols` cache is
		// different: its parser (T_lib_symbols case) explicitly uses a
		// throwaway, ALWAYS-EMPTY map — the parser's own comment says "No
		// derived symbols are allowed in the library cache" — so an `extends`
		// reference written there can never resolve in real KiCad, no matter
		// how the base is named or where it sits. Confirmed against a real
		// exported file: this app's own renderer resolved the extends chain
		// fine (SchematicPainter.relevantSubUnits still does, for backward
		// compatibility with already-saved files), but real KiCad rendered
		// the placed symbol with no body/pins at all. Real KiCad's own
		// placement path (SCH_SYMBOL's constructor / SetLibSymbol) always
		// calls LIB_SYMBOL::Flatten() before caching a symbol on a schematic
		// — clone the base's full body (fields + graphics + sub-units), then
		// overlay the derived symbol's own field properties on top, exactly
		// mirroring that function — so this app now writes the same
		// self-contained, extends-free entry real KiCad itself would.
		if (source.isDerived()) {
			const baseName = source.getExtends()!;
			const base = candidates.find(symbol => symbol.symbolName === baseName);
			if (base) {
				detached = this.flattenDerivedLibSymbol(base, source, libId);
			}
		}

		this.pushUndoSnapshot('Place symbol');
		this.ensureLibSymbol(libId, () => detached);

		const referenceBase = String(source.getAllProperties().Reference ?? 'U').replace(/^~|\?.*$/g, '').trim() || 'U';
		// Real KiCad's "Annotate Automatically" toolbar toggle
		// (`EESCHEMA_SETTINGS::m_AnnotatePanel.automatic`): off means a fresh
		// placement gets the real un-annotated placeholder shape ("<prefix>?")
		// instead of an immediately-assigned number, left for a later
		// annotateSchematic() pass — see that method's own doc comment.
		const reference = reuseReference
			?? (this.annotateAutomatically ? this.nextSymbolRef(referenceBase) : `${ referenceBase }?`);
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
				hide: property?.isHidden?.() ?? (name !== 'Reference' && name !== 'Value')
			};
		};
		instance.addChild(
			KicadElementSymbol.buildLibraryProperty('Reference', reference, propertyAt('Reference', -2.54)));
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
			if (kid?.name !== 'symbol' || typeof (kid as any).getReference !== 'function') {
				continue;
			}
			const value = String((kid as any).getReference() ?? '');
			const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const match = new RegExp(`^${ escapedPrefix }(\\d+)$`).exec(value);
			if (match) {
				max = Math.max(max, Number(match[1]));
			}
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
		'image', 'table'
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
				// (lib_name "X") overrides the lib_symbols lookup key when
				// present — see SchematicPainter.buildSymbolInstance's
				// identical fix for why. The copied instance's own `el.write()`
				// output (below) still carries its lib_name child verbatim,
				// so looking the definition up under the right name here is
				// what keeps a pasted symbol like this pointing at a real
				// (included) lib_symbols entry instead of a missing one.
				const libLookupName = el.getLibName?.() ?? el.getLibId?.();
				if (libLookupName) {
					libIds.add(libLookupName);
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
				parts.push(`(lib_symbols\n${ defs.join('\n') }\n)`);
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
			wrapper = new KicadParser().parse(`(kicad_sch\n${ text }\n)`);
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
			ids.map(id => (this.schScene!.hitTestItems.find(it => it.id === id)?.element as any)?.getUuid?.())
				.filter(Boolean)
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
		if (!this.activeRoot?.rootElement) {
			return 0;
		}
		this.pushUndoSnapshot();
		const idSet = new Set(ids);
		const children: any[] = this.activeRoot.rootElement.children;
		let removed = 0;
		for (const id of idSet) {
			const item = this.activeScene?.hitTestItems.find(it => it.id === id);
			let el = item?.element;
			// Board-only: a pad hit deletes its owning footprint — pads
			// aren't root children themselves (footprint-local, nested), so
			// without this the indexOf below would just silently no-op.
			if (this.documentType === 'board' && item?.kind === 'pad') {
				while (el && !(el instanceof KicadElementFootprint)) {
					el = el.parent;
				}
			}
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

	/** Extracts the current definition of one embedded lib_symbols entry as
	 *  KiCad s-expression text — used by the symbol editor to sync its own
	 *  "real" AST (SymbolEditorScreen.currentSymbol, loaded from the actual
	 *  .kicad_sym file) after an interactive edit lands on this session's
	 *  own throwaway preview document (see SymbolEditorScreen's own doc
	 *  comment for why editing happens there: pins/shapes get real per-item
	 *  paint ids and hit-testing/mutation for free by reusing the placed-
	 *  instance rendering path, rather than needing a parallel body-only
	 *  renderer). */
	getEmbeddedLibrarySymbolText(libId: string): string | null {
		if (this.documentType !== 'schematic' || !this.schematicRoot?.rootElement) {
			return null;
		}
		const libSymbols = this.schematicRoot.rootElement.findFirstChildByClass(KicadElementLibSymbols);
		return libSymbols?.findSymbolByName(libId)?.write() ?? null;
	}

	/** Removes one pin/graphic/text item from the symbol body it belongs to
	 *  — NOT from the schematic root's own children the way deleteElements()
	 *  does, since a symbol body's items live nested inside its lib_symbols
	 *  entry (lib_symbols > symbol > pin/rectangle/circle/...), not at the
	 *  document root. Used by the symbol editor's Delete tool/key; refuses a
	 *  kind:'symbol' hit (the placed preview instance itself must not be
	 *  deleted this way) and anything with no parent to splice out of. */
	deleteSymbolBodyItem(paintId: string): boolean {
		if (this.documentType !== 'schematic' || !this.schematicRoot || !this.schScene) {
			return false;
		}
		const item = this.schScene.hitTestItems.find(it => it.id === paintId);
		const el: any = item?.element;
		if (!item || item.kind === 'symbol' || !el?.parent?.children) {
			return false;
		}
		const siblings: any[] = el.parent.children;
		const idx = siblings.indexOf(el);
		if (idx < 0) {
			return false;
		}
		this.pushUndoSnapshot('Delete');
		siblings.splice(idx, 1);
		this.commitAstMutation();
		return true;
	}

	/** Rotates one symbol-body item (pin/graphic/text) 90° around its own
	 *  pivot point. Ported from real KiCad's symbol-editor rotate behavior
	 *  (eeschema/tools/symbol_editor_edit_tool.cpp: for a SINGLE selected
	 *  item the pivot is always that item's own position/center — never
	 *  (0,0) or the mouse, that only applies to a multi-item selection this
	 *  app doesn't support rotating yet). Per kind: a pin's `at x y` and a
	 *  text item's anchor stay fixed — only their quantized orientation/
	 *  angle field cycles by ±90° (`SCH_PIN::Rotate`/`SCH_TEXT::Rotate` both
	 *  pivot on that exact point, so the position math cancels to a no-op);
	 *  a circle rotates about its own already-fixed center (a genuine no-op
	 *  on center+radius storage — real KiCad's own circle pivot is its
	 *  center too, per `EDA_SHAPE::getCenter()`'s CIRCLE case); a rectangle/
	 *  bezier/polyline pivots on its own first stored point (real KiCad's
	 *  `m_start`, NOT necessarily its visual center — its bounding box CAN
	 *  shift, matching real KiCad exactly, not a bug); an arc pivots on its
	 *  true geometric center (`m_arcCenter`, computed here via circumcenter
	 *  of start/mid/end), degrading to its start point if those three
	 *  points are collinear/degenerate. `direction`: 1 = CCW (real KiCad's
	 *  `R` hotkey), -1 = CW (`Shift+R`) — reuses `Angle.rotatePoint()`'s own
	 *  exact 90°/270° shortcut formulas rather than a second hand-rolled
	 *  rotation implementation. Returns the item's paint id AFTER the
	 *  mutation, which the caller must adopt as its new `selectedPaintId` —
	 *  an arc's id is derived from its (generally shifting, thanks to
	 *  floating-point noise even though the pivot is conceptually fixed)
	 *  center coordinates (see `buildSymArc`), so `paintId` can go stale the
	 *  instant this returns, the same class of bug this app already hit and
	 *  fixed once for position-derived pin ids during drag (see
	 *  `SymbolEditorScreen`'s doc comment on `onWindowMouseMove`). Resolved
	 *  by re-finding the scene item that wraps the SAME (in-place-mutated)
	 *  AST element object — `commitAstMutation()` repaints from the existing
	 *  AST without reparsing, so object identity survives the rebuild. */
	rotateSymbolBodyItemById(paintId: string, direction: 1 | -1): string | null {
		if (this.documentType !== 'schematic' || !this.schScene) {
			return null;
		}
		const el: any = this.schScene.hitTestItems.find(it => it.id === paintId)?.element;
		if (!el || !this.rotateElementGeometry(el, direction)) {
			return null;
		}
		this.commitAstMutation();
		return this.schScene?.hitTestItems.find(it => it.element === el)?.id ?? null;
	}

	/** Mirror counterpart to {@link rotateSymbolBodyItemById} — see that
	 *  method's doc comment for the shared pivot-per-kind rules. `axis`:
	 *  'horizontal' flips left-right (negates X — real KiCad's Mirror
	 *  Horizontally / `X` hotkey), 'vertical' flips top-bottom (negates Y —
	 *  Mirror Vertically / `Y` hotkey); this naming is NOT swapped despite
	 *  the temptation to assume so (confirmed against real KiCad's
	 *  `SCH_ACTIONS::mirrorH`/`mirrorV`, which carry an explicit comment
	 *  noting it used to be backwards before KiCad 6.0). A pin's orientation
	 *  swaps RIGHT↔LEFT under a horizontal mirror / UP↔DOWN under a vertical
	 *  one (and is unaffected by the other axis) — same reasoning applies to
	 *  a text item's quantized angle field. Returns the post-mutation paint
	 *  id — see {@link rotateSymbolBodyItemById}'s doc comment for why this
	 *  can differ from the id passed in. */
	mirrorSymbolBodyItemById(paintId: string, axis: 'horizontal' | 'vertical'): string | null {
		if (this.documentType !== 'schematic' || !this.schScene) {
			return null;
		}
		const el: any = this.schScene.hitTestItems.find(it => it.id === paintId)?.element;
		if (!el || !this.mirrorElementGeometry(el, axis)) {
			return null;
		}
		this.commitAstMutation();
		return this.schScene?.hitTestItems.find(it => it.element === el)?.id ?? null;
	}

	/** Per-shape geometry dispatch rotateSymbolBodyItemById() resolves an id
	 *  to before calling this — same shape-accessor branches
	 *  translateElementGeometry() uses (getPoints/getStartMidEnd/
	 *  getStartEnd/getCenter/getOrigin), but rotating each shape's defining
	 *  points 90° around ITS OWN pivot instead of translating by a delta. */
	private rotateElementGeometry(el: any, direction: 1 | -1): boolean {
		const angle = Angle.fromDegrees(direction === 1 ? 90 : 270);
		if (typeof el.getPoints === 'function' && typeof el.setPoints === 'function') {
			const points = el.getPoints();
			const pivot = points[0];
			if (!pivot) {
				return false;
			}
			const origin = new Vec2(pivot.x, pivot.y);
			el.setPoints(points.map((p: { x: number; y: number }) => angle.rotatePoint(new Vec2(p.x, p.y), origin)));
			return true;
		}
		if (typeof el.getStartMidEnd === 'function' && typeof el.setStartMidEnd === 'function') {
			const { start, mid, end } = el.getStartMidEnd();
			const pivot = arcCircumcenter(start, mid, end) ?? start;
			const origin = new Vec2(pivot.x, pivot.y);
			const s = angle.rotatePoint(new Vec2(start.x, start.y), origin);
			const m = angle.rotatePoint(new Vec2(mid.x, mid.y), origin);
			const e = angle.rotatePoint(new Vec2(end.x, end.y), origin);
			el.setStartMidEnd(s.x, s.y, m.x, m.y, e.x, e.y);
			return true;
		}
		if (typeof el.getStartEnd === 'function' && typeof el.setStartEnd === 'function') {
			const { start, end } = el.getStartEnd();
			const e2 = angle.rotatePoint(new Vec2(end.x, end.y), new Vec2(start.x, start.y));
			el.setStartEnd(start.x, start.y, e2.x, e2.y);
			return true;
		}
		if (typeof el.getCenter === 'function') {
			// Circle: rotating about its own already-fixed center is a
			// genuine no-op on center+radius storage.
			return true;
		}
		if (typeof el.getOrigin === 'function' && typeof el.setOrigin === 'function') {
			const origin = el.getOrigin();
			const next = (((origin.rotation ?? 0) + (direction === 1 ? 90 : -90)) % 360 + 360) % 360;
			el.setOrigin(origin.x, origin.y, next);
			return true;
		}
		return false;
	}

	/** Mirror counterpart to rotateElementGeometry() — same shape-accessor
	 *  branches, reflecting each shape's defining points across a line
	 *  through its own pivot instead of rotating them. */
	private mirrorElementGeometry(el: any, axis: 'horizontal' | 'vertical'): boolean {
		const reflect = (x: number, y: number, cx: number, cy: number): { x: number; y: number } =>
			axis === 'horizontal' ? { x: 2 * cx - x, y } : { x, y: 2 * cy - y };
		if (typeof el.getPoints === 'function' && typeof el.setPoints === 'function') {
			const points = el.getPoints();
			const pivot = points[0];
			if (!pivot) {
				return false;
			}
			el.setPoints(points.map((p: { x: number; y: number }) => reflect(p.x, p.y, pivot.x, pivot.y)));
			return true;
		}
		if (typeof el.getStartMidEnd === 'function' && typeof el.setStartMidEnd === 'function') {
			const { start, mid, end } = el.getStartMidEnd();
			const pivot = arcCircumcenter(start, mid, end) ?? start;
			const s = reflect(start.x, start.y, pivot.x, pivot.y);
			const m = reflect(mid.x, mid.y, pivot.x, pivot.y);
			const e = reflect(end.x, end.y, pivot.x, pivot.y);
			el.setStartMidEnd(s.x, s.y, m.x, m.y, e.x, e.y);
			return true;
		}
		if (typeof el.getStartEnd === 'function' && typeof el.setStartEnd === 'function') {
			const { start, end } = el.getStartEnd();
			const e2 = reflect(end.x, end.y, start.x, start.y);
			el.setStartEnd(start.x, start.y, e2.x, e2.y);
			return true;
		}
		if (typeof el.getCenter === 'function') {
			// Circle: mirroring about its own already-fixed center is a
			// genuine no-op on center+radius storage.
			return true;
		}
		if (typeof el.getOrigin === 'function' && typeof el.setOrigin === 'function') {
			const origin = el.getOrigin();
			const rotation = origin.rotation ?? 0;
			let next = rotation;
			if (axis === 'horizontal') {
				if (rotation === 0) {
					next = 180;
				}
				else if (rotation === 180) {
					next = 0;
				}
			}
			else if (rotation === 90) {
				next = 270;
			}
			else if (rotation === 270) {
				next = 90;
			}
			el.setOrigin(origin.x, origin.y, next);
			return true;
		}
		return false;
	}

	/** Board equivalent of resizeElementBoundsById. PCB images only support a
	 * uniform scale, while board rectangles and axis-aligned text boxes own
	 * explicit start/end corners. */
	resizeBoardElementBoundsById(
		id: string, x: number, y: number, width: number, height: number, handle?: ResizeHandle): boolean {
		if (this.documentType !== 'board' || !this.boardRoot || !this.scene || !(width > 0) || !(height > 0)) {
			return false;
		}
		const item = this.scene.hitTestItems.find(candidate => candidate.id === id);
		const el: any = item?.element;
		if (!item || !el) {
			return false;
		}
		if ((el.name === 'gr_rect' || el.name === 'gr_text_box') && typeof el.setStartEnd === 'function') {
			if (el.name === 'gr_text_box' && Number(el.findFirstChildByName?.('angle')?.attributes?.[0]?.value ?? 0)
				!== 0) {
				return false;
			}
			el.setStartEnd(x, y, x + width, y + height);
		}
		else if (el.name === 'image' && typeof el.getOrigin === 'function'
			&& typeof el.setOrigin === 'function' && typeof el.getScale === 'function'
			&& typeof el.setScale === 'function' && item.shape.type === 'rect') {
			const currentScale = Number(el.getScale() ?? 1);
			const widthRatio = width / item.shape.w;
			const heightRatio = height / item.shape.h;
			const ratio = handle && !handle.includes('e') && !handle.includes('w') ? heightRatio : widthRatio;
			const nextWidth = item.shape.w * ratio;
			const nextHeight = item.shape.h * ratio;
			const fixedRight = x + width;
			const fixedBottom = y + height;
			const nextX = handle?.includes('w') ? fixedRight - nextWidth : x;
			const nextY = handle?.includes('n') ? fixedBottom - nextHeight : y;
			el.setScale(Math.max(1e-6, currentScale * ratio));
			el.setOrigin(nextX + nextWidth / 2, nextY + nextHeight / 2);
		}
		else if (el.name === 'barcode' && typeof el.getOrigin === 'function'
			&& typeof el.setOrigin === 'function' && typeof el.setSize === 'function') {
			const rotation = Number(el.getOrigin().rotation) || 0;
			if (rotation !== 0) {
				return false;
			}
			el.setSize(width, height);
			el.setOrigin(x + width / 2, y + height / 2, rotation);
		}
		else {
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
		// A dimension's own measured points move like any other WithPts
		// element (the generic branch just below handles that), but its
		// text label lives on a SEPARATE child (KicadElementGrText) with its
		// own origin — dragging the dimension's line/crossbar (this branch)
		// should carry the label along with it, same as real KiCad's default
		// "keep text aligned" behavior. Dragging the label ON ITS OWN goes
		// through a different paint item pointed directly at the text child
		// (see BoardPainter.buildDimension's doc comment), which reaches the
		// getOrigin/setOrigin branch below instead — never this one.
		if (el instanceof KicadElementDimension) {
			const textEl = el.findFirstChildByClass(KicadElementGrText);
			if (textEl && typeof textEl.getOrigin === 'function' && typeof textEl.setOrigin === 'function') {
				const origin = textEl.getOrigin();
				textEl.setOrigin(origin.x + dx, origin.y + dy, origin.rotation);
			}
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
			return this.moveSymbolByRef(
				item.refDesignator ?? '', origin.x + dx, origin.y + dy, origin.rotation, item.id);
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
			return this.moveLabelById(
				item.id, Number(current.x ?? 0) + dx, Number(current.y ?? 0) + dy, current.rotation ?? 0);
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
			if (!item) {
				continue;
			}
			const { x, y, w, h } = item.bbox;
			if (![x, y, w, h].every(Number.isFinite) || w < 0 || h < 0) {
				continue;
			}
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
				case 'left':
					dx = minX - bbox.x;
					break;
				case 'right':
					dx = maxX - (bbox.x + bbox.w);
					break;
				case 'top':
					dy = minY - bbox.y;
					break;
				case 'bottom':
					dy = maxY - (bbox.y + bbox.h);
					break;
				case 'center-x':
					dx = centerX - (bbox.x + bbox.w / 2);
					break;
				case 'center-y':
					dy = centerY - (bbox.y + bbox.h / 2);
					break;
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
	resizeElementBoundsById(
		id: string, x: number, y: number, width: number, height: number, handle?: ResizeHandle): boolean {
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
			if (!center) {
				return false;
			}
			if (anchor === 'circle-center' && typeof el.setCenter === 'function') {
				el.setCenter(x, y);
			}
			else if (anchor === 'circle-radius' && typeof el.setRadius === 'function') {
				el.setRadius(Math.max(0.001, Math.hypot(x - center.x, y - center.y)));
			}
			else {
				return false;
			}
		}
		else if (anchor.startsWith('arc-') && el.name === 'arc' && typeof el.getStartMidEnd === 'function'
			&& typeof el.setStartMidEnd === 'function') {
			const { start, mid, end } = el.getStartMidEnd();
			if (anchor === 'arc-start' || anchor === 'arc-mid' || anchor === 'arc-end') {
				// KiCad's default KEEP_CENTER_ADJUST_ANGLE_RADIUS mode keeps the
				// center.  Midpoint drags change only radius, while endpoint drags
				// also adopt the cursor's angle for the dragged endpoint; the other
				// endpoint is resized to the same radius.
				if (typeof el.getArcCenterRadiusAngles !== 'function') {
					return false;
				}
				let geometry: { centerX: number; centerY: number; radius: number };
				try {
					geometry = el.getArcCenterRadiusAngles(false);
				}
				catch {
					return false;
				}
				const radius = Math.max(0.0254, Math.hypot(x - geometry.centerX, y - geometry.centerY));
				const scale = radius / Math.max(geometry.radius, 1e-9);
				const resize = (point: { x: number; y: number }) => ({
					x: geometry.centerX + (point.x - geometry.centerX) * scale,
					y: geometry.centerY + (point.y - geometry.centerY) * scale
				});
				const cursorVector = { x: x - geometry.centerX, y: y - geometry.centerY };
				const cursorLength = Math.hypot(cursorVector.x, cursorVector.y);
				const cursorPoint = cursorLength > 1e-9
					? {
						x: geometry.centerX + cursorVector.x * radius / cursorLength,
						y: geometry.centerY + cursorVector.y * radius / cursorLength
					}
					: resize(anchor === 'arc-end' ? end : start);
				const nextStart = anchor === 'arc-start' ? cursorPoint : resize(start);
				const nextMid = resize(mid);
				const nextEnd = anchor === 'arc-end' ? cursorPoint : resize(end);
				el.setStartMidEnd(nextStart.x, nextStart.y, nextMid.x, nextMid.y, nextEnd.x, nextEnd.y);
			}
			else if (anchor === 'arc-center' && typeof el.getArcCenterRadiusAngles === 'function') {
				let geometry: { centerX: number; centerY: number };
				try {
					geometry = el.getArcCenterRadiusAngles(false);
				}
				catch {
					return false;
				}
				const dx = x - geometry.centerX;
				const dy = y - geometry.centerY;
				el.setStartMidEnd(start.x + dx, start.y + dy, mid.x + dx, mid.y + dy, end.x + dx, end.y + dy);
			}
			else {
				return false;
			}
		}
		else if (anchor.startsWith('bezier-') && el.name === 'bezier'
			&& typeof el.getPoints === 'function' && typeof el.setPoints === 'function') {
			const points = el.getPoints();
			if (!Array.isArray(points) || points.length !== 4) {
				return false;
			}
			const index = anchor === 'bezier-start' ? 0
				: anchor === 'bezier-control-1' ? 1
					: anchor === 'bezier-control-2' ? 2 : anchor === 'bezier-end' ? 3 : -1;
			if (index < 0) {
				return false;
			}
			const next = points.map((point: { x: number; y: number }, pointIndex: number) =>
				pointIndex === index ? { x, y } : { x: point.x, y: point.y });
			el.setPoints(next);
		}
		else if (anchor.startsWith('polygon-vertex-')) {
			const index = Number(anchor.slice('polygon-vertex-'.length));
			const polyline = el.name === 'rule_area' && typeof el.getPolyline === 'function' ? el.getPolyline() : el;
			if (!polyline || typeof polyline.getPoints !== 'function' || typeof polyline.setPoints !== 'function'
				|| !Number.isInteger(index)) {
				return false;
			}
			const points = polyline.getPoints();
			if (!Array.isArray(points) || index < 0 || index >= points.length) {
				return false;
			}
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
		this.rebuildBoardSceneIfPending();
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
			const paintActive = (
				viewBBox?: { x: number; y: number; w: number; h: number }, highlightSet: Set<string> = highlighted,
			) => {
				if (this.documentType === 'schematic') {
					this.schematicPainter.paint(
						this.schScene!, renderer, this.schLayerState, highlightSet, this.highlightedNetIds, viewBBox);
				}
				else {
					this.painter.paint(
						this.scene!, renderer, this.layerState, this.activeBoardLayer,
						this.zoneDisplayMode,
						highlightSet,
						{ pad: this.padDisplayMode, via: this.viaDisplayMode, track: this.trackDisplayMode },
						this.highlightedBoardNetId, viewBBox
					);
				}
			};
			// Board selection highlighting draws through paintHighlightOverlay's
			// cheap per-frame DYNAMIC pass instead (see its own doc comment and
			// the call site below) — so the STATIC build below must never bake
			// a board selection color into its buffers, or every click-select
			// would still force a full rebuild via geometryDirty regardless.
			// Schematic selection is unchanged (still baked statically) — a
			// separately-scoped follow-up, not touched here.
			const staticHighlighted = this.documentType === 'board' ? new Set<string>() : highlighted;

			if (renderer.beginStaticBuild) {
				if (this.geometryDirty) {
					if (this.activeBoardDragPerformance && this.documentType === 'board') {
						this.activeBoardDragPerformance.staticRebuilds++;
					}
					renderer.beginStaticBuild();
					// No viewBBox — this pass tessellates once into GPU buffers
					// that then persist across pans/zooms, so it must capture
					// everything, not just what's on-screen right now.
					paintActive(undefined, staticHighlighted);
					renderer.endStaticBuild!();
					this.committedTrackOverlay.length = 0;
					this.geometryDirty = false;
				}
				renderer.beginDynamicFrame!();
				if (this.gridVisible) {
					this.drawGrid(renderer);
				}
				// Draws the grid (behind everything) then the already-uploaded
				// static scene on top of it. The overlay content below must be
				// a SEPARATE dynamic pass started only after this flush() —
				// WebGL accumulates draw calls into one buffer that gets drawn
				// as a unit, so anything accumulated before this point would
				// end up drawn BEHIND the static scene, not on top of it (the
				// exact bug behind a dragged footprint rendering underneath
				// the rest of the board — see Renderer.flushOverlay's doc
				// comment).
				renderer.flush?.();
				renderer.beginDynamicFrame!();
			}
			else {
				if (this.gridVisible) {
					this.drawGrid(renderer);
				}
				// Canvas2D redraws the whole scene every frame (see this
				// method's doc comment) — cull to the current viewport, grown
				// 20% so items just outside the edge don't pop in/out on pan.
				const viewBBox = this.camera.bbox.grow(this.camera.bbox.w * 0.2, this.camera.bbox.h * 0.2);
				paintActive(viewBBox);
			}
			// Always last — the hand-drawn editor's in-progress tool state, board
			// drag preview, etc. draw on top of everything else, for both
			// backends. Canvas2D's calls above already painted immediately, so
			// these just draw immediately on top too, in call order; WebGL
			// accumulated them into the fresh dynamic buffer just started above,
			// and flushOverlay() draws JUST that — no second static redraw to
			// cover it back up.
			this.drawBoardRatsnest(renderer);
			this.drawBoardOrigins(renderer);
			this.drawBoardDragPreview(renderer);
			this.drawCommittedTrackOverlay(renderer);
			this.drawEditPreview(renderer);
			this.drawBoardHighlight(renderer);
			// The cheap per-frame counterpart to paint()'s static highlightOverlay
			// — see paintHighlightOverlay's own doc comment for why selection no
			// longer bakes into the static build above. WebGL only
			// (renderer.beginStaticBuild): Canvas2D already redraws the whole
			// scene every frame via paintActive()'s own (unchanged, full)
			// `highlighted` set above, so this would just be a redundant
			// second draw of the same already-yellow shape there.
			if (this.documentType === 'board' && this.scene && renderer.beginStaticBuild) {
				paintHighlightOverlay(
					this.scene, renderer, this.selectedIds,
					{ pad: this.padDisplayMode, via: this.viaDisplayMode, track: this.trackDisplayMode },
				);
			}
			this.drawZoneEditHandles(renderer);
			this.drawDimensionEditHandles(renderer);
			this.drawSelectionResizeHandles(renderer);
			this.drawSelectionCurveAnchors(renderer);
			this.drawBoardCrosshair(renderer);
			if (renderer.flushOverlay) {
				renderer.flushOverlay();
			}
			else {
				renderer.flush?.();
			}

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
		const gridOrigin = schematic ? new Vec2(0, 0) : this.boardGridOrigin;
		const startX = Math.floor((bbox.x - gridOrigin.x) / spacing) - 1;
		const endX = Math.ceil((bbox.x2 - gridOrigin.x) / spacing) + 1;
		const startY = Math.floor((bbox.y - gridOrigin.y) / spacing) - 1;
		const endY = Math.ceil((bbox.y2 - gridOrigin.y) / spacing) + 1;
		// WebGL uses premultiplied-alpha blending. The very low-opacity KiCad
		// theme color that looked fine in the desktop renderer became almost
		// indistinguishable from this viewer's dark background, so use a muted
		// blue-gray with enough alpha to remain legible on the GPU canvas.
		const gridColor = schematicGridColor;
		renderer.beginBatch?.();
		for (let ix = startX; ix <= endX; ix++) {
			const width = minorDotWorld * (ix % gridTick === 0 ? 2 : 1);
			const x = gridOrigin.x + ix * spacing;
			for (let iy = startY; iy <= endY; iy++) {
				const height = minorDotWorld * (iy % gridTick === 0 ? 2 : 1);
				const y = gridOrigin.y + iy * spacing;
				renderer.rect(new Vec2(x - width / 2, y - height / 2), width, height, { fillColor: gridColor });
			}
		}
		renderer.endBatch?.();
	}

	/** Pcbnew keeps origin markers visible independently of grid visibility. */
	protected drawBoardOrigins(renderer: Renderer): void {
		if (this.documentType !== 'board' || !Number.isFinite(this.camera.zoom) || this.camera.zoom <= 0) {
			return;
		}
		// ORIGIN_VIEWITEM converts its default 16-pixel size and one-pixel
		// stroke to world coordinates on each ViewDraw call. Keep that same
		// screen-space treatment here, so zoom changes position but not glyph
		// dimensions.
		const radius = 16 / this.camera.zoom;
		const width = 1 / this.camera.zoom;
		const drawMarker = (origin: Vec2, color: string, style: 'circle-cross' | 'circle-x') => {
			if (origin.x === 0 && origin.y === 0) {
				return;
			}
			renderer.circle(origin, radius, { strokeColor: color, strokeWidth: width });
			if (style === 'circle-x') {
				renderer.line([
					new Vec2(origin.x - radius, origin.y - radius), new Vec2(origin.x + radius, origin.y + radius)
				], { strokeColor: color, strokeWidth: width, capStyle: 'butt' });
				renderer.line([
					new Vec2(origin.x - radius, origin.y + radius), new Vec2(origin.x + radius, origin.y - radius)
				], { strokeColor: color, strokeWidth: width, capStyle: 'butt' });
				return;
			}
			renderer.line([
				new Vec2(origin.x - radius, origin.y), new Vec2(origin.x + radius, origin.y)
			], { strokeColor: color, strokeWidth: width, capStyle: 'butt' });
			renderer.line([
				new Vec2(origin.x, origin.y - radius), new Vec2(origin.x, origin.y + radius)
			], { strokeColor: color, strokeWidth: width, capStyle: 'butt' });
		};
		// Exact Pcbnew ORIGIN_VIEWITEM styles: its default grid origin is a
		// pale CIRCLE_X, while Board Editor Control creates a red CIRCLE_CROSS
		// for the drill/place-file origin.
		drawMarker(this.boardGridOrigin, '#d5e0e6', 'circle-x');
		drawMarker(this.boardDrillPlaceOrigin, '#cc0000', 'circle-cross');
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
			case 'wire': {
				// computeWireBend (utils.ts) returns a plain {x,y} literal, not a
				// real Vec2, to stay decoupled from the math module — wrap it
				// here since Renderer.line() needs actual Vec2 instances.
				const bend = computeWireBend(p.from, p.cursor, this.lineMode);
				const bendPoint = bend ? new Vec2(bend.x, bend.y) : null;
				renderer.line(
					bendPoint ? [p.from, bendPoint, p.cursor] : [p.from, p.cursor], { strokeColor: color, strokeWidth: 0.15 });
				break;
			}
			case 'line':
				renderer.line([p.anchor ?? p.cursor, p.cursor], { strokeColor: color, strokeWidth: 0.15 });
				if (!p.anchor) {
					drawCrosshair(renderer, p.cursor, color);
				}
				break;
			case 'route':
				renderer.line(
					[...p.points, p.cursor],
					{ strokeColor: p.collides ? ROUTE_COLLISION_COLOR : color, strokeWidth: p.width }
				);
				break;
			case 'via-drag':
				for (const track of p.tracks) {
					renderer.line([...track.points, p.cursor], { strokeColor: color, strokeWidth: track.width });
				}
				if (p.viaSize) {
					renderer.circle(p.cursor, p.viaSize / 2, { fillColor: color });
				}
				break;
			case 'junction':
				renderer.circle(p.cursor, 0.4, { fillColor: color });
				break;
			case 'no-connect': {
				const half = 0.9;
				renderer.line(
					[new Vec2(p.cursor.x - half, p.cursor.y - half), new Vec2(p.cursor.x + half, p.cursor.y + half)],
					{ strokeColor: color, strokeWidth: 0.3 }
				);
				renderer.line(
					[new Vec2(p.cursor.x - half, p.cursor.y + half), new Vec2(p.cursor.x + half, p.cursor.y - half)],
					{ strokeColor: color, strokeWidth: 0.3 }
				);
				break;
			}
			case 'rect': {
				if (!p.anchor) {
					drawCrosshair(renderer, p.cursor, color);
					break;
				}
				const corners = [
					new Vec2(p.anchor.x, p.anchor.y), new Vec2(p.cursor.x, p.anchor.y),
					new Vec2(p.cursor.x, p.cursor.y), new Vec2(p.anchor.x, p.cursor.y)
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
					renderer.arc(
						new Vec2(local.centerX, local.centerY), local.radius, local.startAngle, local.endAngle,
						{ strokeColor: color, strokeWidth: 0.15 }
					);
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
			case 'dimension': {
				if (p.points.length === 0) {
					drawCrosshair(renderer, p.cursor, color);
					break;
				}
				if (p.points.length === 1) {
					renderer.line([p.points[0]!, p.cursor], { strokeColor: color, strokeWidth: 0.1 });
					break;
				}
				const [first, second] = p.points;
				const dx = second!.x - first!.x;
				const dy = second!.y - first!.y;
				const length = Math.hypot(dx, dy);
				if (length === 0) {
					drawCrosshair(renderer, p.cursor, color);
					break;
				}
				const orientation = Math.abs(dx) >= Math.abs(dy) ? 0 : 1;
				const height = p.type === 'orthogonal'
					? (orientation === 0 ? p.cursor.y - first!.y : p.cursor.x - first!.x)
					: ((p.cursor.x - first!.x) * -dy + (p.cursor.y - first!.y) * dx) / length;
				const lineStart = p.type === 'orthogonal'
					?
					(orientation === 0 ? new Vec2(first!.x, first!.y + height) : new Vec2(first!.x + height, first!.y))
					: new Vec2(first!.x - dy / length * height, first!.y + dx / length * height);
				const lineEnd = p.type === 'orthogonal'
					? (orientation === 0 ? new Vec2(second!.x, second!.y + height) :
						new Vec2(second!.x + height, second!.y))
					: new Vec2(second!.x - dy / length * height, second!.y + dx / length * height);
				renderer.line([first!, lineStart], { strokeColor: color, strokeWidth: 0.1 });
				renderer.line([second!, lineEnd], { strokeColor: color, strokeWidth: 0.1 });
				renderer.line([lineStart, lineEnd], { strokeColor: color, strokeWidth: 0.1 });
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
				const strokeColor = p.mode === 'contained' ? SELECTION_BOX_OUTLINE_CONTAINED :
					SELECTION_BOX_OUTLINE_TOUCHING;
				renderer.rect(new Vec2(x0, y0), w, h, { fillColor, strokeColor, strokeWidth: 0.15 });
				break;
			}
		}
	}

	/** One plain flat-ended line per airwire — real KiCad's own ratsnest is a
	 *  thin solid line, not dashed. The dashed version this replaced chopped
	 *  every airwire into many ~1mm segments, and WebGLRenderer gives every
	 *  open polyline a pair of round semicircle end caps by default — for a
	 *  board with hundreds of unrouted airwires that was thousands of extra
	 *  tiny fans tessellated every single drag frame (measured as the
	 *  dominant per-frame draw cost with ratsnest visible). One segment with
	 *  capStyle: 'butt' draws the same visual line for a fraction of the
	 *  geometry. */
	protected drawBoardRatsnest(renderer: Renderer): void {
		if (this.documentType !== 'board' || !this.ratsnestVisible) {
			return;
		}
		for (const line of this.ratsnestLines) {
			renderer.line([line.from, line.to], { strokeColor: '#b7c7d8', strokeWidth: 0.05, capStyle: 'butt' });
		}
	}

	/** Draws every footprint currently under an active drag-preview (see
	 *  beginBoardDragPreview) through the same per-frame dynamic path as the
	 *  grid/ratsnest — these items were built fresh this frame by
	 *  updateBoardDragPreview() and were deliberately removed from the real
	 *  (static-buffer-backed) scene, so this is the ONLY place they get
	 *  drawn from during the drag. Mirrors LayeredBoardScene.paint()'s own
	 *  per-item logic (footprint synthetic bbox / highlight color) since
	 *  these items never flow through paint() itself. */
	protected drawBoardDragPreview(renderer: Renderer): void {
		if (this.dragPreviewFootprints.size === 0) {
			return;
		}
		for (const items of this.dragPreviewFootprints.values()) {
			// buildFootprint() emits items in BUILD order (pads sorted
			// biggest-first, then properties, then graphics) — not layer
			// paint order. paint() gets layer ordering for free by walking
			// scene.layersPresent (itself layerPaintOrder-sorted) one layer
			// at a time; this preview draws straight from the flat items
			// list instead, so without its own sort here, a through-hole
			// pad's B.Cu copy (pushed right after its F.Cu copy in
			// buildPad) drew ON TOP of the F.Cu one — showing the back
			// layer's color (blue) despite F.Cu being the active layer,
			// while single-layer SMD pads (no ordering ambiguity) looked
			// correct. Sorted once per frame; footprint item counts are
			// small (tens, not thousands), so this is not worth caching.
			const layers = [...new Set(items.map(item => item.layer))]
				.sort((a, b) => layerPaintRank(a) - layerPaintRank(b));
			const activeOrder = new Map(boardPaintOrder(layers, this.activeBoardLayer)
				.map((layer, index) => [layer, index]));
			const sorted = [...items].sort((a, b) => activeOrder.get(a.layer)! - activeOrder.get(b.layer)!);
			for (const item of sorted) {
				const state = this.layerState.get(item.layer);
				if (!state || !state.visible) {
					continue;
				}
				const highlighted = this.selectedIds.has(item.id);
				if (item.kind === 'footprint') {
					if (highlighted) {
						renderer.rect(
							new Vec2(item.bbox.x, item.bbox.y), item.bbox.w, item.bbox.h,
							{ strokeColor: '#ffcc00', strokeWidth: 0.18 }
						);
					}
					continue;
				}
				const color = highlighted ? '#ffcc00' : styleForLayer(item.layer).color;
				const mode = item.kind === 'pad' ? this.padDisplayMode
					: item.kind === 'via' ? this.viaDisplayMode
						: item.kind === 'track' ? this.trackDisplayMode
							: 'filled';
				item.draw(renderer, color, mode);
			}
		}
	}

	protected drawCommittedTrackOverlay(renderer: Renderer): void {
		for (const item of this.committedTrackOverlay) {
			if (!this.isBoardLayerVisible(item.layer)) continue;
			const state = this.layerState.get(item.layer);
			renderer.setOpacity?.(state?.opacity ?? 1);
			item.draw(renderer, styleForLayer(item.layer).color, this.trackDisplayMode);
		}
	}

	/** Draws boardHighlight's outline, padded a little beyond the
	 *  footprint's own bbox so the outline doesn't hug pad edges exactly —
	 *  see setFootprintHighlight(). Procedural like drawEditPreview/
	 *  drawGrid, so panning/zooming/re-selecting never needs a scene
	 *  rebuild, just another frame. */
	protected drawBoardHighlight(renderer: Renderer): void {
		const highlight = this.boardHighlight;
		if (this.documentType !== 'board' || !highlight) {
			return;
		}
		const { x, y, w, h } = highlight.bbox;
		const pad = Math.max(0.5, Math.max(w, h) * 0.08);
		renderer.rect(
			new Vec2(x - pad, y - pad), w + pad * 2, h + pad * 2,
			{ strokeColor: BOARD_HIGHLIGHT_COLOR, strokeWidth: 0.2 }
		);
	}

	/** Real KiCad's 3 GAL cursor styles (opengl_gal.cpp's blitCursor()),
	 *  drawn at workingPointWorld — the current snapped WORKING point, not
	 *  the raw pointer (see that field's doc comment for why: this is what
	 *  actually shows the user a pad/via/track magnetizing a route, since
	 *  the browser's own OS cursor can't be moved to reflect a snap the way
	 *  a real desktop app's self-drawn cursor can). 'small' is a short fixed
	 *  screen-length cross; 'full'/'diagonal' extend across the whole
	 *  viewport. */
	protected drawBoardCrosshair(renderer: Renderer): void {
		if (this.documentType !== 'board' || !this.boardPointerScreen) {
			return;
		}
		const zoom = this.camera.zoom;
		if (!Number.isFinite(zoom) || zoom <= 0) {
			return;
		}
		const center = this.workingPointWorld ?? this.screenToWorld(this.boardPointerScreen);
		const deviceScale = window.devicePixelRatio || 1;
		const lineWidth = deviceScale / zoom;
		const style = { strokeColor: BOARD_CURSOR_COLOR, strokeWidth: lineWidth, capStyle: 'butt' as const };
		if (this.crosshairMode === 'small') {
			const half = (12 * deviceScale) / zoom;
			renderer.line([new Vec2(center.x - half, center.y), new Vec2(center.x + half, center.y)], style);
			renderer.line([new Vec2(center.x, center.y - half), new Vec2(center.x, center.y + half)], style);
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
		if (this.crosshairMode === 'full') {
			renderer.line([new Vec2(bbox.x, center.y), new Vec2(bbox.x + bbox.w, center.y)], style);
			renderer.line([new Vec2(center.x, bbox.y), new Vec2(center.x, bbox.y + bbox.h)], style);
			return;
		}
		// 'diagonal': ±45° lines through the pointer, long enough to clear
		// the viewport at any pan/rotation of the aspect ratio.
		const reach = Math.hypot(bbox.w, bbox.h);
		renderer.line(
			[new Vec2(center.x - reach, center.y - reach), new Vec2(center.x + reach, center.y + reach)], style);
		renderer.line(
			[new Vec2(center.x - reach, center.y + reach), new Vec2(center.x + reach, center.y - reach)], style);
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
		const background = this.documentType === 'board' ? boardBackgroundColor : schematicBackgroundColor;
		const deviceScale = window.devicePixelRatio || 1;
		const lineWidth = deviceScale / this.camera.zoom;
		const size = 7 * deviceScale / this.camera.zoom;
		renderer.line([
			new Vec2(box.x, box.y), new Vec2(x2, box.y), new Vec2(x2, y2), new Vec2(box.x, y2), new Vec2(box.x, box.y)
		], { strokeColor: color, strokeWidth: lineWidth });
		for (const point of [
			new Vec2(box.x, box.y), new Vec2(cx, box.y), new Vec2(x2, box.y),
			new Vec2(box.x, cy), new Vec2(cx, cy), new Vec2(x2, cy),
			new Vec2(box.x, y2), new Vec2(cx, y2), new Vec2(x2, y2)
		]) {
			renderer.rect(new Vec2(point.x - size / 2, point.y - size / 2), size, size, {
				fillColor: color,
				strokeColor: background,
				strokeWidth: lineWidth
			});
		}
	}

	/** PCB counterpart to drawSelectionCurveAnchors's polygon case — square
	 *  handles at each existing zone outline vertex, round handles at each
	 *  edge midpoint (dragging one inserts a new corner there; see
	 *  getBoardPolygonAnchors/moveBoardPolygonPoint/insertBoardPolygonPoint).
	 *  Reads the LIVE zone geometry straight off the AST every frame rather
	 *  than tracking separate drag-preview state — the drag handlers below
	 *  already commit each mousemove via commitAstMutation() (the same
	 *  established pattern moveCurveAnchorById uses on the schematic side),
	 *  so the handles simply track whatever the zone's outline currently is. */
	protected drawZoneEditHandles(renderer: Renderer): void {
		if (this.documentType !== 'board' || this.selectedIds.size !== 1
			|| !Number.isFinite(this.camera.zoom) || this.camera.zoom <= 0) {
			return;
		}
		const anchors = this.getBoardPolygonAnchors([...this.selectedIds][0]!);
		if (!anchors) {
			return;
		}
		const color = '#ffcc00';
		const deviceScale = window.devicePixelRatio || 1;
		const lineWidth = deviceScale / this.camera.zoom;
		const size = 7 * deviceScale / this.camera.zoom;
		const radius = size / 2;
		for (const midpoint of anchors.midpoints) {
			renderer.circle(midpoint, radius, {
				fillColor: color, strokeColor: boardBackgroundColor, strokeWidth: lineWidth
			});
		}
		for (const corner of anchors.corners) {
			renderer.rect(new Vec2(corner.x - size / 2, corner.y - size / 2), size, size, {
				fillColor: color, strokeColor: boardBackgroundColor, strokeWidth: lineWidth
			});
		}
	}

	/** The 5 real-KiCad dimension point-editor handles (see
	 *  getDimensionEditAnchors' own doc comment for what each one does) —
	 *  drawn whenever either of a dimension's own two paint sub-items (its
	 *  `:line` or its independently-selectable `:text`) is the current
	 *  single selection, so grabbing the text handle works the same whether
	 *  you'd selected the crossbar or the label itself. */
	protected drawDimensionEditHandles(renderer: Renderer): void {
		if (this.documentType !== 'board' || this.selectedIds.size !== 1
			|| !Number.isFinite(this.camera.zoom) || this.camera.zoom <= 0) {
			return;
		}
		const anchors = this.getDimensionEditAnchors([...this.selectedIds][0]!);
		if (!anchors) {
			return;
		}
		const color = '#ffcc00';
		const deviceScale = window.devicePixelRatio || 1;
		const lineWidth = deviceScale / this.camera.zoom;
		const size = 7 * deviceScale / this.camera.zoom;
		for (const point of [...anchors.measured, ...anchors.crossbar]) {
			renderer.rect(new Vec2(point.x - size / 2, point.y - size / 2), size, size, {
				fillColor: color, strokeColor: boardBackgroundColor, strokeWidth: lineWidth
			});
		}
		renderer.rect(new Vec2(anchors.text.x - size / 2, anchors.text.y - size / 2), size, size, {
			fillColor: color, strokeColor: boardBackgroundColor, strokeWidth: lineWidth
		});
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
				.sort((a, b) => Number(a.kind.slice('polygon-vertex-'.length)) - Number(
					b.kind.slice('polygon-vertex-'.length)))
				.map(anchor => new Vec2(anchor.x, anchor.y));
			renderer.line([...points, points[0]!], { strokeColor: color, strokeWidth: lineWidth });
		}
		for (const point of byKind.values()) {
			renderer.rect(new Vec2(point.x - size / 2, point.y - size / 2), size, size, {
				fillColor: color,
				strokeColor: schematicBackgroundColor,
				strokeWidth: lineWidth
			});
		}
	}
}

/** Semi-transparent white reads as a "ghost" preview over any real element
 *  color underneath, without colliding with schColors' saturated palette. */
const EDIT_PREVIEW_COLOR = 'rgba(255, 255, 255, 0.6)';
/** Route preview color when the candidate path violates clearance —
 *  matches real KiCad's own collision-red ratsnest/highlight convention. */
const ROUTE_COLLISION_COLOR = 'rgba(255, 64, 64, 0.9)';

/** Opaque, saturated yellow — reads clearly against board copper/silkscreen
 *  colors at any zoom, and doesn't collide with any of them (see
 *  setFootprintHighlight). */
const BOARD_HIGHLIGHT_COLOR = '#ffcc00';

/** wdark.json's board.cursor value (the user's actual active PCB color
 *  theme) — see kicad-wdark-theme-reference memory; not guessed. */
const BOARD_CURSOR_COLOR = 'rgb(255, 255, 255)';

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

import { drawCrosshair, rotatePreviewPoint, drawLabelFlagPreview } from './editPreview';
