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

## Modules (all in `shared/kicad-render/`)

### `geometry/` — kimath geometry core  [COMPLETE]
- `Shape.ts` (SHAPE base + SHAPE_TYPE), `ShapeLineChain.ts`, `ShapeSegment.ts`,
  `ShapeRect.ts`, `ShapeCircle.ts`, `ShapeArc.ts` (incl. FromTwoPointsAndAngle,
  angle accessors), `ShapePolySet.ts` (outlines/holes/Fracture/Booleans via
  Clipper2/Inflate/Triangulate/Area/Centroid/Distance/NearestPoint/Format/
  WriteFilledPolys), `ShapeCollision.ts` (SHAPE_COLLISION + lazy registration),
  `ShapeCompound.ts`, `ShapeIndexList.ts`, `Seg.ts`, `BOX2.ts`, `Transform.ts`,
  `ConvertToPolygon.ts`, `polygon.ts`, `format.ts`, `units.ts`, `sch_geometry.ts`.
- README has the file->C++ mapping.

### `connectivity/` — KiCad connectivity + board model  [BROAD, COMPLETE-ISH]
- Port: ConnectivityItems / ConnectivityAlgo / ConnectivityData / RatsnestData /
  RtreeNode / DynamicRtree / netinfo / clearance / padstack / pad_clearances /
  thermal_relief / LayerId / PlotLayer / ratsnest_view / drill_grid / BoardStackup /
  netlist / board / track / footprint / board.ts
- Facades (scene + AST) use canonical SHAPE collision; zones triangulated into
  CN_ZONE_LAYER R-tree (fixes false airwires); full 32 copper + tech layers.
- README documents the port.

### `router/` — PNS router  [BROAD]
- PnsNode (PNS_ITEM/LINE/SOLID/VIA/SEGMENT/DIFF_PAIR/NODE), PnsDragger,
  PnsHull, PnsOptimizer, PnsWalkaround, RouterGeometry, DiffPair.

### `paint/` — display model/renderer  [RENDERER — KEEP, TS-NATIVE]
- PaintedShape / HitTest / BoardPainter / BoardZoneFill / SchematicPainter /
  DrawingSheet (incl. .kicad_wks parser + title block) / KicadStringEscapes etc.

## Progress log (most recent first)
- Board setup -> netclass wiring (applySetupToNetInfo), DRAW_MODE/visibility
  config, text metrics (measureText)
- Hierarchical sheet + global-label connectivity, schematic netlist from root
  (buildSchematicNetlistFromRoot), power-flag + bus netname resolution
- Schematic netname resolution (+ power flags, bus labels), schematic->netlist
- DrawingSheet frame layout (computeWksLayout), fp-editor, plot/Gerber export
- BEZIER geometry, text reflow, thermal-relief helper
- BoardStackup, pad connection points, netlist extractor, .kicad_wks parser
- KICAD_T (SCH_*) completion, drill geometry, angle helpers
- Solder mask/paste polygons, title block, plot-layer iterator
- Netclass clearance, FOOTPRINT model, diff-pair dims
- PNS_*, BOARD model, units, EDA_TEXT, ConvertToPolygon, full layers, SEG

## Next batch candidates (in suggested order)
1. **Wire the new canonical models into `KicadRenderSession`** (BOARD/TRACK/
   FOOTPRINT/netlist/netname resolution) replacing ad-hoc session use
2. **Solder-mask/paste + thermal-relief wiring into `BoardZoneFill`** — canonical
   API provided, fill kept as-is
3. Schematic connectivity completion: exact pin/wire endpoint matching,
   sheet hierarchy instance resolution, net-ties
4. `ClangFormat`-style KiCad test vectors -> unit-test parity (when we switch
   to validation)

## Known rework remaining / to finish
- `KicadBoardFacade.Drawings()` `never[]` type quirk (pre-existing, benign).
- `BoardZoneFill` still uses its own ad-hoc tessellation (display-layer;
  optionally migrate to `ConvertToPolygon`).
- Router geometry migrated off legacy `PaintedShape` coords; PNS_ROUTER top-level
  tool not yet wired.
