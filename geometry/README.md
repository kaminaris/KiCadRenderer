# geometry — KiCad geometry (kimath) parity port

This folder is a **1:1 port of KiCad's geometry core** (`libs/kimath/src/geometry/*`)
to TypeScript. It is the canonical geometric model that the connectivity port
(`connectivity/`) and the item painters should use, replacing the ad-hoc local
`PaintedShape` / `hitTestShape` collision currently sprinkled through the
facades.

> KiCad 10's `SHAPE_POLY_SET` uses **Clipper2** for its boolean ops and inflate
> (the C++ ships `libs/kimath/src/geometry/shape_poly_set_shape_poly_set_clipper.cpp`).
> The existing `paint/ClipperEngine.ts` wraps `@clipper2-ts`, so the TS port can
> stay faithful for `BooleanAdd`/`BooleanSubtract`/`BooleanIntersection`/
> `Inflate` — same library the C++ uses.

## File ↔ C++ source mapping

| This folder | KiCad C++ source | Status |
| --- | --- | --- |
| `Shape.ts` | `libs/kimath/include/geometry/shape.h` | ✅ |
| `ShapeLineChain.ts` | `shape_line_chain.{h,cpp}` | ✅ |
| `ShapeSegment.ts` | `shape_segment.{h,cpp}` | ✅ |
| `ShapeRect.ts` | `shape_rect.{h,cpp}` | ✅ |
| `ShapeCircle.ts` | `shape_circle.{h,cpp}` | ✅ |
| `ShapeArc.ts` | `shape_arc.{h,cpp}` | ✅ |
| `ShapePolySet.ts` | `shape_poly_set.{h,cpp}` + `shape_poly_set_clipper.cpp` | ✅ |
| `ShapeCollision.ts` | `shape_collision.{h,cpp}` | ✅ |
| `ShapeCompound.ts` | `shape_compound.{h,cpp}` | 🔲 (union of shapes) |
| `ShapeIndex/ShapeIndexList` | `shape_index.{h,cpp}`, `shape_index_list.{h,cpp}` | ✅ (AABB list) |
| `Seg.ts` | `libs/kimath/include/geometry/seg.{h,cpp}` | ✅ (line segment) |
| `ConvertToPolygon.ts` | `pcbnew/convert_shape_list_to_polygon.cpp` | ✅ (shape→filled poly) |
| `polygon.ts` | — (shared point-in-polygon / point-to-segment / edge-distance predicates) | ✅ |

## Porting convention

Same as `connectivity/README.md`: translate don't improve, keep names/comments
close to the C++, keep the license header, drop the wx/boost noise, port the
quirk. The `Vec2` type in `math/Vec2.ts` stands in for both `VECTOR2I` and
`VECTOR2D` (all arithmetic is in mm; the existing renderer already works in mm).

## Geometry feature used by the rest of the system

The `SHAPE_*` model is now wired into the connectivity port:

- `connectivity/CN_ZONE_LAYER` feeds its **real triangulated** polygon set
  (from `SHAPE_POLY_SET::Triangulate`) into its 2D R-tree, so zone↔item
  collisions actually fire — this is what makes a "fully connected" board
  stop showing false airwires (verified by `tests/zone-wall-sanity.ts`).
- `AstAdapter.GetEffectiveShape()` returns real `SHAPE`s (pads → SHAPE_RECT,
  vias → SHAPE_CIRCLE, tracks/arcs → SHAPE_SEGMENT, zones → SHAPE_POLY_SET) so
  the connectivity visitor does exact collision via `SHAPE_COLLISION`.
- `SHAPE::Collide()` is routed through `SHAPE_COLLISION`, registered lazily
  (`setShapeCollisionCtor`) to avoid a circular module-init dependency
  (Shape → ShapeCollision → ShapePolySet → Shape).

## Tests

- `tests/geometry-sanity.ts` — primitives (segment/rect/circle/line-chain/arc),
  `SHAPE_POLY_SET` (outlines/holes/booleans/triangulate/contains) and
  `SHAPE_COLLISION` (segment-segment, segment-circle, poly-set collide).
- `tests/zone-wall-sanity.ts` — `CN_ZONE_LAYER` triangulated R-tree
  `ContainsPoint` end-to-end.
