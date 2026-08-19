// Extracted shared types from KicadRenderSession.ts

export type RenderBackend = 'webgl' | 'canvas2d';
export type RenderDocumentType = 'board' | 'schematic';

export interface LoadResult {
	parseMs: number;
	buildMs: number;
	layersPresent: string[];
}

export interface ZoneDraft {
	layers: string[];
	/** 0 = real KiCad's own "<no net>" floating-copper-pour representation. */
	netId: number;
	netName: string;
	name: string;
	locked: boolean;
	clearanceMm: number;
	minThicknessMm: number;
	padConnection: any;
	thermalGapMm: number;
	thermalSpokeWidthMm: number;
	cornerSmoothing: any;
	cornerRadiusMm: number;
	islandRemoval: any;
	islandAreaMinMm: number;
	priority: number;
	hatchStyle: any;
	hatchPitchMm: number;
}

export interface RuleAreaDraft {
	layers: string[];
	name: string;
	locked: boolean;
	hatchStyle: any;
	hatchPitchMm: number;
	keepout: any;
}

export interface PolygonDraft {
	layer: string;
	lineWidthMm: number;
	lineStyle: any;
	fillMode: any;
	locked: boolean;
	netName: string;
}

export interface HitResult {
	id: string;
	kind: string;
	layer: string;
	refDesignator?: string;
	labelName?: string;
	labelKind?: string;
	netName?: string | null;
	length?: number;
}

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'w' | 'center' | 'e' | 'sw' | 's' | 'se';
export type AlignAxis = 'left' | 'right' | 'top' | 'bottom' | 'center-x' | 'center-y';

export type CurveAnchor = 'circle-center' | 'circle-radius' | 'arc-start' | 'arc-mid' | 'arc-end' | 'arc-center'
	| 'bezier-start' | 'bezier-control-1' | 'bezier-control-2' | 'bezier-end'
	| `polygon-vertex-${number}`;

export interface SelectionCurveAnchors {
	id: string;
	kind: 'circle' | 'arc' | 'bezier' | 'polygon';
	anchors: { kind: CurveAnchor; x: number; y: number }[];
}

export type SchLineMode = 'free' | '90' | '45';

/**
 * Real per-project design-rule values a caller can source from the board's
 * `.kicad_pro` (KicadProjectFile.getMinClearanceMm() /
 * getCopperEdgeClearanceMm() / getDefaultNetClassClearanceMm()) rather than
 * this app guessing a single hardcoded number. kicad-render itself has no
 * Project-level type (KicadRenderSession only ever sees the board's own
 * AST), so this stays a plain optional data bag the caller fills in.
 * Omitted/absent fields fall back to BoardZoneFill's own real-KiCad-stock-
 * default edge clearance, or to the zone's own local override alone for
 * pad/track clearance — exactly matching this feature's pre-existing
 * behavior for a board with no project.
 */
export interface ZoneFillDesignSettings {
	/** Board Setup > Design Rules > Constraints > "Clearance" — floors the
	 *  pad/track/via exclusion gap alongside the zone's own connect_pads
	 *  override and the Default net class's clearance. */
	minClearanceMm?: number;
	/** Board Setup > Design Rules > Constraints > "Copper to edge
	 *  clearance" — passed straight to buildEdgeExclusionsByLayer. */
	copperEdgeClearanceMm?: number;
	/** The "Default" net class's own clearance — real KiCad implicitly
	 *  derives CLEARANCE_CONSTRAINT per net class this way; this app has no
	 *  per-net netclass-assignment model yet, so this is applied board-wide
	 *  rather than per pad/track. */
	defaultNetClassClearanceMm?: number;
}

export interface SelectionResizeBox {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Live, uncommitted state for the hand-drawn-editor's active tool — what's
 * been clicked so far plus the current cursor position. Drawn every frame by
 * drawEditPreview() directly (mirroring drawGrid()'s idiom), never part of
 * the persisted scene — nothing here is real document data until the tool
 * commits it via one of the add*() methods. Point/anchor fields are `any`
 * (really `Vec2`) to keep this module import-free.
 */
export type EditPreviewState =
	| { kind: 'wire'; from: any; cursor: any }
	| { kind: 'junction'; cursor: any }
	| { kind: 'no-connect'; cursor: any }
	| { kind: 'line' | 'rect' | 'circle'; anchor: any | null; cursor: any }
	/** points: [] before the start click, [start] before the end click,
	 *  [start, end] while dragging the mid-bulge (cursor = the mid point). */
	| { kind: 'arc'; points: any[]; cursor: any }
	| { kind: 'bezier'; points: any[]; cursor: any }
	| { kind: 'rule-area'; points: any[]; cursor: any }
	| { kind: 'dimension'; type: 'aligned' | 'orthogonal'; points: any[]; cursor: any }
	| { kind: 'text'; anchor: any; text: string }
	| { kind: 'text-box'; x: number; y: number; width: number; height: number; text: string }
	| { kind: 'label'; anchor: any; text: string; rotation: number }
	| { kind: 'global-label' | 'hier-label'; anchor: any; text: string; shape: any; rotation: number }
	| { kind: 'directive-label'; anchor: any; text: string; shape: any; rotation: number }
	| {
		kind: 'route'; points: any[]; cursor: any; width: number;
		/** True when the candidate path (as currently drawn) violates
		 *  clearance against different-net copper — drawn in the collision
		 *  color instead of the normal preview color, matching real KiCad's
		 *  "highlight collisions" routing mode. Still placeable; this is a
		 *  warning, not a block (see BoardPointerController.updateRoutePreview). */
		collides?: boolean
	}
	/** Via drag: one polyline per connected track's near-side elbow (each
	 *  ending at `cursor`, the live-dragged position), optionally drawn
	 *  alongside a circle at that point (omit `viaSize`, or pass 0, for a
	 *  bare-point convergence with no via — see
	 *  KicadRenderSession.trackCornerDragFanout's doc comment; the kind name
	 *  predates that reuse). Multiple tracks (one per bridged copper layer,
	 *  or one per line touching a dragged track corner) share the one
	 *  cursor point — see KicadRenderSession.viaDragFanout's doc comment for
	 *  why this needs its own kind instead of reusing 'route' (which only
	 *  ever draws one width/layer at a time). */
	| { kind: 'via-drag'; tracks: { points: any[]; width: number }[]; cursor: any; viaSize?: number }
	/** Power symbols place in one click (like junction/no-connect) — no
	 *  glyph preview needed, just a cursor-follow marker. */
	| { kind: 'power'; cursor: any }
	/** Select tool's rectangle multi-select drag. `mode` is the contained
	 *  ('origin'→cursor drawn left-to-right) vs touching (right-to-left)
	 *  distinction; `selectMode` is what committing the box will do to the
	 *  existing selection, both driving live color feedback — see
	 *  SELECTION_BOX_* constants. Deliberately unsnapped (origin/cursor are
	 *  raw world coordinates), unlike every other preview kind above. */
	| { kind: 'selection-box'; origin: any; cursor: any; mode: 'contained' | 'touching'; selectMode: 'replace' | 'add' | 'subtract' };

/** One connected track's whole assembled line, as computed once by
 *  KicadRenderSession.viaDragFanout at via-drag gesture start —
 *  `segmentIds`/`originPoints` stay fixed for the whole gesture (the real,
 *  as-drawn line the via currently terminates); only the chain the caller
 *  rebuilds each frame via dragViaChain(originPoints, cursor, ...) changes
 *  as the mouse moves. `originPoints` is ordered far-anchor-first (index 0
 *  = the fixed pad/junction/other via at the far end; last index = the
 *  via's pre-drag position) and `segmentIds[k]` is the id of the segment
 *  connecting `originPoints[k]` to `originPoints[k+1]` — see
 *  viaDragFanout's and dragViaChain's doc comments. */
export interface ViaDragFix {
	segmentIds: string[];
	originPoints: any[];
	width: number;
	layer: string;
	netId: number | null;
}

/** Placed schematic symbol pose for edit/drag without a circuit recipe. */
export interface SymbolPoseInfo {
	ref: string;
	libId: string;
	x: number;
	y: number;
	rotation: number;
}
