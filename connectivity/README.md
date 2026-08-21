# connectivity — KiCad connectivity port

This folder is a **1:1 port of KiCad's C++ connectivity/ratsnest engine**
(`pcbnew/connectivity/*`, `pcbnew/ratsnest/ratsnest_data.*` and
`kimath/geometry/rtree/*`) to TypeScript. It is deliberately NOT a
from-scratch reimplementation — the goal is maximum parity with the C++ so
that future KiCad fixes/features can be ported mechanically.

> **Experimental branch note:** this is being maintained on an experimental
> git branch as a direct translation. Type-checking is done by the consuming
> app's own build (yarn PnP); the folder's `.ts` files are not self-verified
> with a standalone `tsc` invocation.

## File ↔ C++ source mapping

| This folder | KiCad C++ source |
| --- | --- |
| `ConnectivityItems.ts` | `pcbnew/connectivity/connectivity_items.h/.cpp` |
| `ConnectivityAlgo.ts` | `pcbnew/connectivity/connectivity_algo.h/.cpp` |
| `ConnectivityData.ts` | `pcbnew/connectivity/connectivity_data.h/.cpp` |
| `RatsnestData.ts` | `pcbnew/ratsnest/ratsnest_data.h/.cpp` |
| `RtreeNode.ts` | `kimath/include/geometry/rtree/rtree_node.h` |
| `DynamicRtree.ts` | `kimath/include/geometry/rtree/dynamic_rtree.h` |
| `BoardAdapter.ts` | — (bridge: scene `PaintedItem` ↔ `BOARD_CONNECTED_ITEM`) |
| `KicadBoardFacade.ts` | — (bridge: board AST ↔ `BOARD` / `BOARD_ITEM`, `AstAdapter`) |
| `KicadRatsnest.ts` | — (public API: `buildKiCadRatsnest*`, `flattenRatsnestEdges`) |

The `BoardAdapter` / `KicadBoardFacade` / `KicadRatsnest` files are the
**only** files that know about the renderer's scene model or the @kicad-io
AST. Everything else is pure KiCad translation and must stay that way.

Both facades now expose their item shapes through the **canonical SHAPE
model** in `../geometry/` (the kimath parity port): `GetEffectiveShape()`
returns `SHAPE_RECT`/`SHAPE_CIRCLE`/`SHAPE_SEGMENT`/`SHAPE_POLY_SET` (pads /
vias / tracks·arcs / zones), and the connectivity visitor's collision runs
through `SHAPE_COLLISION`. This replaced the old ad-hoc `PaintedShapeAdapter`
collision. Zones additionally feed a real `SHAPE_POLY_SET::Triangulate()` into
`CN_ZONE_LAYER`'s R-tree so zone↔pad/via/track collisions actually fire.

## Porting convention

- **Translate, don't improve.** Keep class/method names, comments, and
  control flow as close to the C++ as TypeScript allows. If the C++ does
  something quirky, port the quirk — do not "fix" it.
- **One file per C++ source file**, same name.
- **Keep the license header** (CERN / KiCad Developers, GPL-2.0-or-later)
  and note the upstream file path in a comment.
- KiCad parallel constructs (thread pools, futures) become single-threaded
  loops in the port; keep the same iteration order and outcome.
- C++ raw-pointer ordering (`aCandidate < m_item`) becomes a deterministic
  per-search sequence number (see `CN_VISITOR` in `ConnectivityAlgo.ts`).
- C++ out-parameters (`uint32_t& aReinsertedLevels`, `int& aFound`) become
  boxed `{ value: number }` objects (see `DynamicRtree.ts`).
- C++ enums not representable in the TS `KICAD_T` const (e.g.
  `PCB_NETINFO_T`, `FP_JUST_ADDED`, `ZLO_*`, `FLASHING`) are defined
  locally with a comment pointing at the upstream header.
- KiCad `wxLogTrace` noise becomes `console.warn`.

## What has been ported

- **R*-tree** (`RtreeNode.ts` + `DynamicRtree.ts`): Insert/Remove/Search/
  RemoveAll with the R*-tree split (choose-axis by perimeter, choose-index
  by overlap + area tie-break), forced reinsert (30% overflow, distance-
  from-node-center), condense/underflow reinsertion on Remove, and the
  `CN_RTREE` wrapper from `connectivity_rtree.h` (3D: layer + bbox; B.Cu
  mapped to INT_MAX). The C++ SoA/SIMD/slab-allocator micro-optimizations
  are deliberately dropped — the scalar loops implement identical
  arithmetic (noted in the file headers).
- **CONNECTIVITY_DATA** (`ConnectivityData.ts`): C++-faithful
  `internalRecalculateRatsnest` (PropagateNets → resize indexed `m_nets` →
  clear dirty nets → addRatsnestCluster → ClearDirtyFlags → updateRatsnest),
  `updateRatsnest` (dirty nets with nodes only), `addRatsnestCluster`,
  `GetRatsnestForNet` (indexed), `GetRatsnestForItems`, `GetRatsnestForPad`,
  `MarkItemNetAsDirty`, `RemoveInvalidRefs`.
- **Local / drag ratsnest** (`ConnectivityData.ts` + `ConnectivityAlgo.ts`
  + `RatsnestData.ts`): the C++ drag-preview path, ported 1:1 —
  `ComputeLocalRatsnest(aItems, aInternalOffset)` (closest static↔dynamic
  pairs via `RN_NET::NearestBicoloredPair` + internal airwires of the moving
  set), `BlockRatsnestItems`, `ClearLocalRatsnest`, `HideLocalRatsnest`,
  `GetLocalRatsnest`, the `RN_DYNAMIC_LINE {netCode, a, b}` type, and the
  `CONNECTIVITY_DATA(aBoard, aLocalItems, aSkipRatsnestUpdate)` local
  constructor. `CN_CONNECTIVITY_ALGO::ForEachAnchor` / `ItemMap()` and
  `ITEM_MAP_ENTRY::IsLinked()` were added to support `ClearLocalRatsnest` /
  `BlockRatsnestItems`.
- **AST-backed board facade** (`KicadBoardFacade.ts`): builds the
  connectivity board from the parsed board AST — pads grouped under their
  footprint (so `IsFreePad`/origin-pad ranking/jumper pads work), track arcs
  as `PCB_ARC_T` with real start/end anchors, vias with their actual layer
  span from `(layers ...)`, and a populated net code→name map from
  `(net ...)` children. `AstAdapter::Pads()` caches its pads so the same
  AstAdapter instances are returned on every call, preserving reference
  identity (matching KiCad's stable `BOARD_ITEM*`) between the connectivity
  item map and the drag-path's moving items.

## Wiring

- `KicadRatsnest.buildKiCadRatsnestFromBoard(boardRoot, scene)` — one-shot
  AST-backed build (used by callers without a session).
- `KicadRenderSession` holds a **persistent `CONNECTIVITY_DATA`**
  (`boardConnectivity`), built from the AST at board load and at
  `refreshBoardRatsnest()`, with edges flattened via
  `flattenRatsnestEdges()` — the same `BoardRatsnestLine[]` shape the legacy
  greedy ratsnest emits, so the renderer paints both identically.
- **Drag preview** (`layers.ts` `beginBoardDragPreview` /
  `updateBoardDragPreview` / `endBoardDragPreview`): uses the ported two-
  connectivity model. `beginBoardDragPreview` builds a dynamic
  `CONNECTIVITY_DATA` over the moving footprints via
  `buildLocalConnectivityForFootprints` and attaches it with
  `SetDynamicConnectivity`. Each move, `updateBoardDragPreview` rebuilds it
  at the (post-translate) positions, refreshes its ratsnest, calls
  `ComputeLocalRatsnest`, and flattens the dynamic lines with
  `flattenDynamicRatsnest`. `endBoardDragPreview` runs `ClearLocalRatsnest`
  and detaches the dynamic data. The session retains the board facade
  (`boardFacade`) and resolves moving footprint elements to their facade
  adapters (`facadeFootprintsFor`) so the static item map and the moving
  items share AstAdapter instances by reference.
- The scene-based `buildKiCadRatsnest(scene)` / `buildGreedyRatsnest(scene)`
  entry points remain for compatibility (fallback when no static
  connectivity is available).

## Known limitations (inherited from the port scope)

- **Layers:** the ported `LSET`/layer numbering only distinguishes F.Cu (0)
  and B.Cu (2). Internal copper layers all collapse to layer 1 and are not
  individually connectable. Vias span 0..INT_MAX (through-hole assumption).
- **Zones:** `CN_ZONE_LAYER` R-trees are empty (the facade reports zero
  triangulated polys), so zone↔item connections via `ContainsPoint`/`Collide`
  don't fire yet. Zone outline anchors are still added, so zone islands
  appear as ratsnest nodes.
- **Pad shapes:** pad effective shapes are bbox rects from `(size ...)`;
  custom (gr_poly) pad outlines are not used for collision.
- **Drag route:** the `ComputeLocalRatsnest` drag path is wired and working,
  but the dynamic data is rebuilt fresh each pointer-move frame (cheap for a
  single moving footprint; a multi-footprint group drag would benefit from
  the C++ `Update`-item incremental path instead). The C++ `aInternalOffset`
  parameter is supported but kept 0 (the AST origins are updated before each
  frame, so no extra offset is needed).

## Adding more KiCad code

Future ports (e.g. `FillIsolatedIslandsMap`, proper zone triangulation +
`SHAPE_POLY_SET`, full `LSET` layer set, `BulkLoad`, `NearestNeighbors`)
should follow the same pattern: port the C++ file 1:1 into this folder,
extend the facades (`BoardAdapter`/`KicadBoardFacade`) only where the scene
or AST can supply the data, and document any gaps here.

## More parity added (KiCad 10 API breadth)

- **`CONNECTIVITY_DATA` query helpers** (`ConnectivityData.ts`): `Move`
  (anchor move for the dynamic ratsnest — RTree boxes intentionally not
  updated, matching the C++ doc), `GetNetItems`, `GetConnectedItemsAtAnchor`,
  `GetConnectedItems`, `GetConnectedPads`, `GetConnectedTracks`,
  `NearestUnconnectedTargets`, plus `RN_NET::GetNodes` /
  `RN_NET::GetNodesAtAnchor`.
- **`CN_CONNECTIVITY_ALGO`** (`ConnectivityAlgo.ts`): `ForEachItem`,
  `ItemList()`, and `Move` (via `ForEachAnchor`).

### Not yet ported — why

- **`FillIsolatedIslandsMap`** (the last substantial public
  `CN_CONNECTIVITY_ALGO` method in KiCad 10) is deliberately NOT ported yet:
  it is only consumed by `zone_filler.cpp` (isolated-copper-island removal)
  and it depends on filled-zone polygon triangulation (`SHAPE_POLY_SET`,
  `ZONE::GetFilledPolysList` → `TriangulatedPolyCount`) — exactly the zone
  gap the facade reports as 0 triangles. Porting it before zone triangulation
  would be dead, unverifiable code. It should be ported together with
  `SHAPE_POLY_SET` triangulation and `LSET::Seq()`.
- **`BulkLoad` / `AddSources` / `AddSource`** (older-KiCad net-source APIs)
  are not in the KiCad 10 `CN_CONNECTIVITY_ALGO` public surface, so they are
  not ported.
