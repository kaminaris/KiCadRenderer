# KiCad Renderer Port — Plan & Status

Location: this repo (`shared/kicad-render/` + `shared/kicad-io/`).
Goal: faithful 1:1 TS port of everything in KiCad that contributes to rendering
schematics/PCB, keeping a thin TS-native (Canvas2d/WebGL) display layer. The
user's directive: "treat existing code as legacy garbage — delete it and replace
with KiCad translations; don't validate, just port as much as possible."

## Guiding conventions
- Port the KiCad C++ 1:1 (translate, don't improve; keep the quirk; keep license
  header + source path). See `connectivity/README.md` and `geometry/README.md`.
- The actual draw calls (GAL/OpenGL/Cairo) are NOT portable — replaced by the
  repo's display layer. We port the geometry/computation, not the GPU calls.
- mm throughout (KiCad's VECTOR2I(nm) is bridged at the Clipper boundary).
- **File naming: ProperCase** (e.g. `SchGeometry.ts`, `TextReflow.ts`,
  `SchematicNetlist.ts`) — NOT underscore_case. Follow this for all new files.

## Modules (all in `shared/kicad-render/`)

### `geometry/` — kimath geometry core  [COMPLETE]
- `Shape.ts` (SHAPE base + SHAPE_TYPE), `ShapeLineChain.ts`, `ShapeSegment.ts`,
  `ShapeRect.ts`, `ShapeCircle.ts`, `ShapeArc.ts` (incl. FromTwoPointsAndAngle,
  angle accessors), `ShapePolySet.ts` (outlines/holes/Fracture/Booleans via
  Clipper2/Inflate/Triangulate/Area/Centroid/Distance/NearestPoint/Format/
  WriteFilledPolys), `ShapeCollision.ts` (SHAPE_COLLISION + lazy registration),
  `ShapeCompound.ts`, `ShapeIndexList.ts`, `Seg.ts`, `BOX2.ts`, `Transform.ts`,
  `ConvertToPolygon.ts`, `polygon.ts`, `format.ts`, `units.ts`, `SchGeometry.ts`.
- README has the file->C++ mapping.

### `connectivity/` — KiCad connectivity + board model  [BROAD, COMPLETE-ISH]
- Port: ConnectivityItems / ConnectivityAlgo / ConnectivityData / RatsnestData /
  RtreeNode / DynamicRtree / netinfo / clearance / padstack / PadClearances /
  ThermalRelief / LayerId / PlotLayer / RatsnestView / DrillGrid / BoardStackup /
  netlist / board / track / footprint / board
- Facades (scene + AST) use canonical SHAPE collision; zones triangulated into
  CN_ZONE_LAYER R-tree (fixes false airwires); full 32 copper + tech layers.
- README documents the port.

### `router/` — PNS router  [BROAD]
- PnsNode (PNS_ITEM/LINE/SOLID/VIA/SEGMENT/DIFF_PAIR/NODE), PnsDragger,
  PnsHull, PnsOptimizer, PnsWalkaround, RouterGeometry, DiffPair, PnsRouter.

### `paint/` — display model/renderer  [RENDERER — KEEP, TS-NATIVE]
- PaintedShape / HitTest / BoardPainter / BoardZoneFill / SchematicPainter /
  DrawingSheet (incl. .kicad_wks parser + title block) / KicadStringEscapes etc.

## Progress log (most recent first)
- Ported top-level `PNS_ROUTER` (`router/PnsRouter.ts`) with StartRouting / Move /
  FixRoute / Cancel cycle, wrapping RouterNode + PnsDragger + PnsHull +
  PnsWalkaround + PnsOptimizer + RouterGeometry. Exported from package index.
- Ported `CN_CONNECTIVITY_ALGO::FillIsolatedIslandsMap` / `CONNECTIVITY_DATA::FillIsolatedIslandsMap`
  (isolated-copper-island removal; progress reporter + cluster-based classification).
- Ported custom pad effective shape (`PAD_SHAPE::CUSTOM` → `SHAPE_POLY_SET` from
  `(primitives (gr_poly ...))` + anchor rect, rotated by pad angle) in
  `KicadBoardFacade.toShape()`.
- Cleaned stale `.js` build artifacts from `connectivity/`.
- Fixed `ConnectivityAlgo.ts` `IsDirty` method-call syntax error.
- Net driver/ERC pin ranking (pinDriverPriority/resolveNetDriver in PinInfo),
  net-code assignment (NetCode: assignNetCodes/NETCODE_LIST), fixed
  SHAPE_LINE_CHAIN closed-loop GetSegment wrapping
- Pin electrical types/shapes (PinInfo), SMD thermal-tie helpers, STEP-like
  solid export (StepExport)
- [rename] standardized all port files to ProperCase
- Power-symbol netclass + sheet-instance bus members, file/export writer,
  EDA_TEXT stroke box
- Board-outline smoothing, SHAPE_POLY_SET::OuterHull, bus-member pin mapping
- Session getters, PCB_DIMENSION, layer Gerber/drill writer
- Schematic exact endpoint matching + net-ties + SCH_POLYLINE
- Board setup -> netclass wiring, DRAW_MODE, text metrics
- Hierarchical sheet + global-label connectivity, schematic netlist from root
- Schematic netname resolution (+ power flags, bus labels), schematic->netlist
- Schematic driver-based net resolution (resolveNetDriver + pin electrical types)
- Sheet-instance-to-instance bus coupling + subgraph code assignment
- DrawingSheet frame layout, fp-editor, plot/Gerber export
- BEZIER geometry, text reflow, thermal-relief helper
- BoardStackup, pad connection points, netlist extractor, .kicad_wks parser
- KICAD_T (SCH_*) completion, drill geometry, angle helpers
- Solder mask/paste polygons, title block, plot-layer iterator
- Netclass clearance, FOOTPRINT model, diff-pair dims
- PNS_*, BOARD model, units, EDA_TEXT, ConvertToPolygon, full layers, SEG

## Next batch candidates (in suggested order)
1. **Solder-mask/paste + thermal-relief wiring into `BoardZoneFill`** — canonical
   API provided; display fill kept as-is
2. `ClangFormat`-style KiCad test vectors -> unit-test parity (when we switch
   to validation)

## Review (assistant, 2025) — your contributed code, verified
Confirmed compiling under the app path mapping (tsc + @kicad-io/@clipper2-ts):
- `connectivity/SchematicConnectionGraph.ts` — project-wide connection_graph
  port (sheet instances, union-find subgraph merging, global/hierarchical/bus
  coupling, driver-based naming, buildProjectNetlist). Solid.
- `router/PnsRouter.ts` — PNS_ROUTER (start/move/fix/cancel, walkaround+shove).
- Rewrote `FillIsolatedIslandsMap` (issue-24089-faithful; single-connection
  outlines; progress; non-copper fix). Uses HasSingleConnection/SubpolyIndex.
- `KicadBoardFacade.toShape` custom (gr_poly) pads unioned w/ anchor rect.
- Driver-based net naming in `SchematicExtractor`; `NETLIST_NET.code`.
Review FIXED real type errors in `SchematicConnectionGraph.ts`: `KicadElementSymbol`
has NO `.Reference`/`.getValue()`/`.getFootprint()`/`.datasheet` (Reference is via
`getReference()`, Value/Footprint/Datasheet via `(property ...)` children) —
replaced with `symbolPropertyValue()` (getPropertyByName). Whole tree green.



## Known rework remaining / to finish
- `KicadBoardFacade.Drawings()` `never[]` type quirk (pre-existing, benign).
- `BoardZoneFill` still uses its own ad-hoc tessellation (display-layer;
  optionally migrate to `ConvertToPolygon`).
- `PNS_ROUTER` exists in `router/PnsRouter.ts` but is not yet wired into
  `BoardPointerController` (apps/kicad-viewer still composes router pieces
  directly).

## Next-steps completed (assistant)
- Unified symbol property extraction: `connectivity/SymbolElement.ts` (symbolReference/
  Value/Footprint/Datasheet via getPropertyByName+property children); used by both
  `SchematicExtractor` and `SchematicConnectionGraph` (removed the local broken-API
  accessors and the local symbolPropertyValue helper).
- Session wiring: `getConnectionGraph()` (single-instance buildConnectionGraph for the
  loaded root), `getRouter()` (lazy PNS_ROUTER, `boardRouter` field), `findLibSymbols`.
- Bus-member netlist tightening: `SchematicExtractor.buildSchematicNetlist` now maps a
  pin whose net is a bus label to its member net by position along the bus wire
  (`memberNetForPin` + `mapBusPinToMember`), fallback to first member.

- Canonical pad-to-zone connection: `connectivity/ZoneFillConnection.ts`
  (resolveRoundPadConnection, buildPadKnockout) wiring PadClearances.effective
  ZoneConnection + ThermalRelief spokes/ring + a Convert callback; the display
  fill (BoardZoneFill) is kept as-is (canonical API is the opt-in).
- Project-level connection graph: `buildProjectConnectionGraph(schematic)`
  (collectSheetInstances + buildConnectionGraph) convenience for multi-sheet.
- Session: getConnectionGraph()/getRouter() (PNS_ROUTER lazy).
- Session: prepareRouterWorld() (rebinds PNS_ROUTER world from the board scene).
- connectivity/PadZoneClearance.ts: pad/via/segment-to-zone clearance helpers.
- padstack.PADSTACK.Collide(layer, pos, other, clearance): per-layer pad DRC.
- connectivity/DrcItem.ts: DRC_ITEM + checkSegmentClearance (clearance-aware track-vs-obstacle).
- geometry/ShapePolySet: DistanceToPolyset + DistanceToSegmentArray (zone-zone outline distance).
- connectivity/ConnectivityData: NetHasAirwires (per-net unconnected check); RatsnestView highlight already present.
- connectivity/PadZoneClearance: trackToViaDrillClearance (drill-aware via clearance).
- FOOTPRINT.graphics + GetGraphics() (fp-editor FP_SHAPE primitives).
- geometry/SchGeometry: SCH_RECTANGLE / SCH_CIRCLE / SCH_ARC graphic shapes.
- geometry/ShapeArc::FromStartEndAndCenter (derive arc midpoint from start/end/center).
- SchematicConnectionGraph: resolveSubgraphNetClasses (power/label netclass resolve).
- FOOTPRINT.Flip() + IsNetTie() + GetConnectionPoints() (ordered) + duplicatePadNumbersAreJumpers.
- BoardStackup.GetViaHeight() (through-via depth).
- geometry/LibSymbolGeometry.ts: LIB_ITEM + libItemToShape/libBodyToCompound + fromSch* adapters
  (schematic symbol body -> canonical SHAPE).
- geometry/ShapeLineChain: FormatCluster() (points S-expr) + GetWidth() accessor.
- interaction/RouteTool.ts: ROUTE_TOOL — interactive route-gesture state machine
  over PNS_ROUTER (SelectStart/MoveCursor/Fix/FixPointAndContinue/Cancel,
  ghost points, snap-to-anchor, setMode/corner/width/layer, injectRouter).
- Session: getRouteTool()/prepareRouteTool() (shares the router instance).
- apps/kicad-viewer/src/editor/BoardPointerController: routing rewritten to drive the
  canonical ROUTE_TOOL (prepareRouteTool + SelectStart/MoveCursor/Fix/TakeCommit +
  SetAllowDrcViolations), applying the canonical PNS_ROUTE_COMMIT via the session's
  addTrackSegment/shoveTrackSegment. Deleted legacy in-house routing path (computeRoutePath,
  attemptShove, planShove, buildRoutePath, miterPath); kept shared drag helpers.
- ROUTE_TOOL: Fix(cursor, aFinish) re-starts routing from the committed endpoint so
  multi-corner runs keep working; SetAllowDrcViolations/SetRemoveRedundantTracks; MoveCursor
  returns the narrowed routing gesture.
- Fixed app-build errors surfaced by the strict app tsconfig: Seg.Dot overload, KicadBoardFacade
  implicit-any ring.map, padstack null shape, PadZoneClearance Vec2 import, DRC_ITEM.owner.
- interaction/UndoRedo.ts: UNDO_REDO container + COMMIT pattern (Add/Remove/Modify,
  Commit->UNDO_REDO_ITEM, Revert), UNDO_REDO_T enum — canonical transaction shape.
- interaction/DragTool.ts: DRAG_TOOL interactive segment/via drag gesture over the
  PnsDragger primitives (Select/Move/Commit/Cancel, 45/90/free) + makeInitialTrace.
- interaction/NetHighlight.ts: netToHighlight + NET_HIGHLIGHT brush state (session's
  highlightBoardNetAtScreen/clearBoardNetHighlight are the live renderer).
- RouteTool.TakeCommitAsUndoRedo() folds a canonical route commit into a COMMIT.
- interaction/Selection.ts: SELECTION set + SELECTION_TOOL (click/box select,
  REPLACE/ADD/TOGGLE/SUBTRACT modifiers, cancel-on-empty, geometry-lookup box membership).
- interaction/SchematicTool.ts: SCHEMATIC_TOOL gesture layer (wire/bus/line draw run,
  junction/no-connect/label/symbol/power placement) over a mutation injection surface.
- interaction/MeasureTool.ts: MEASURE_TOOL (click-preview-finalize, distance/dx/dy/angle).
- interaction/ZoneTool.ts: ZONE_TOOL (zone-outline polygon gesture -> commit outline -> fill
  via a ZoneSink injection surface).
- geometry/FpPrimitives: FP_SHAPE ELLIPSE Shape() fixed (sampled polyline, not segment);
  added rx/ry fields; added FP_TEXT + FP_FIELD (reference/value/footprint/datasheet/description).
- geometry/SchGeometry: added SCH_PIN (position/orientation/length/electrical type/number/name).
- connectivity/ExcellonExport.ts: Excellon drill-file (.drl) writer — M48/METRIC tool defs
  (T1Csize per distinct drill diameter), G90/G00/G71/G85, grouped G85 hits, M30 end.
  Consumes DRILL_LAYOUT. (+ collectDrillHits convenience.)
- connectivity/BoardOutline: added EDGE_ITEM (line/arc) + flattenEdgeItems (arcs sampled via
  arcToPolyline into chords) + buildEdgeOutline — board-edge S-curve support.
- connectivity/ExcellonExport: added drillMapLegend (per-size hole+Ø summary lines).
## Integration pass (ratsnest wiring)
- Session: added computePreviewRatsnest / setPreviewRatsnest / clearPreviewRatsnest —
  canonical CONNECTIVITY_DATA path for the hover/drag preview overlay.
- apps/kicad-viewer BoardPointerController: the two hover/drag preview call sites now use
  session.computePreviewRatsnest + session.setPreviewRatsnest (no (session as any) casts,
  no buildKiCadGreedyRatsnest import). The deprecated buildGreedyRatsnest alias is no longer
  referenced by the app. Killed the preview-ratsnest escape hatches.
## Integration pass (interaction toolkit + ratsnest/drag)
- Session facade now exposes the whole interaction toolkit as lazy singletons:
  getRouteTool / getDragTool / getSelectionTool / getMeasureTool / getSchematicTool
  (wired to addWire/addBus/addJunction/addNoConnect) / getZoneTool / getUndoRedo, plus
  computePreviewRatsnest / setPreviewRatsnest / clearPreviewRatsnest.
- apps/kicad-viewer: track-body drag now drives session.getDragTool() (canonical DRAG_TOOL
  Select/Move) instead of the direct dragSegment45 primitive; hover/drag preview ratsnest uses
  session.computePreviewRatsnest/setPreviewRatsnest (no (session as any) writes, no
  buildKiCadGreedyRatsnest import). Killed the preview-ratsnest + track-drag escape hatches.
- Remaining escape hatches: (dragTargets as any)._accumDx/Dy for footprint-drag fast-path
  translation (a separate board-translate concern, not the router tooling).
## Integration pass (selection -> canonical SELECTION_TOOL)
- Session selection is now routed through the canonical SELECTION_TOOL as the
  authoritative store: select/selectMultiple/clearSelection/delete call
  getSelectionTool().GetSelection() (Clear/AddMany/Remove), and selectedIds is kept
  in sync as the render-facing readout. Added private setSelectedIds/clearSelectionAll/
  removeFromSelection helpers. All ~6 direct selectedIds mutators (including load/reset
  clears) now go through the tool; the many selectedIds READS (render paths) are untouched.
- App type-check green; no render regression expected (reads unchanged).
## Decision: @kicad-layout out of scope
- The schematic auto-rewire netlist (@kicad-layout LockNetlist/Rewire/Connectivity) is
  intentionally NOT swapped to the canonical SchematicNetlist/SchematicConnectionGraph.
  @kicad-layout is excluded from the current integration scope (user decision) — it is a
  separate in-house connectivity layer and is not to be modified.
- The canonical getSchematicNetlist()/getConnectionGraph() remain exposed on the session
  for when that boundary is revisited.
## BUGFIX: spurious ratsnest lines (vias treated as unconnected)
- Root cause: SHAPE_COLLISION.Collide had no CIRCLE-vs-RECT or RECT-vs-RECT case, so
  via→rect-pad / rect→rect collisions fell through to the shapeDistance fallback, which
  returned raw center-to-center distance (no extent subtraction) — so overlapping shapes
  reported distance > 0 and failed the same-net connection, splitting each net into
  track/via-only islands (the "<none>" clusters) and painting ratsnest edges on every via.
- Fix (geometry/ShapeCollision.ts): added collideCircleRect (closest-point-on-rect within
  radius) and collideRectRect (AABB overlap / edge-gap); fixed shapeDistance to be the
  correct conservative bounding-circle edge distance (centerDist - ra - rb).
- App strict type-check green.
## BUGFIX (real cause): spurious ratsnest lines on routed boards
- Root cause (deeper): `KicadBoardFacade.copperLayersOf` only read the plural
  `(layers ...)` accessor (el.getLayers). But segments/arcs/track-arcs use the SINGULAR
  `(layer "F.Cu")` form and expose el.getLayer() (WithLayer mixin), not getLayers().
  So every track resolved to an EMPTY layer set -> no common layer with its via/pad ->
  never connected -> each track+via became its own cluster -> ratsnest lines everywhere
  on a fully-routed board. (The earlier CIRCLE-vs-RECT collision fix was necessary but
  NOT sufficient.)
- Fix: copperLayersOf now also falls back to el.getLayer() (singular) and filters to
  .Cu layers, so tracks/arcs get their real copper layer and connect.
- App strict type-check green.
## BUGFIX (2 real causes, found via a runnable diagnostic on the real board)
1) SHAPE_COLLISION was never registered in the app runtime — only the test suite imported
   ShapeCollision.ts, so setShapeCollisionCtor never ran and every SHAPE.Collide used the
   broken center-distance fallback (fails coincident track<->via/pad). Fix: side-effect
   `import '../geometry/ShapeCollision'` in ConnectivityAlgo.ts.
2) (earlier this session) copperLayersOf only read the plural (layers ...) accessor; board
   segments/arcs use the singular (layer "X") and expose getLayer(), so tracks had empty
   layer sets. Fixed to fall back to getLayer().
- Confirmed on GigaMicroEPCV2: tracks all resolve layers (5691/5691); via-track collision
  goes false->true once ShapeCollision is imported. Direct track/via/pad-connected nets now
  coalesce.
- REMAINING GAP: zone/pour-connected items (large ground nets e.g. net 112) still split —
  CN_ZONE_LAYER's ContainsPoint/Collide doesn't yet coalesce pour-connected pads/vias. This
  is a separate, larger zone-connectivity port gap (Tracked, not yet fixed).
