/** Plain-AABB overlap test — duck-typed against {x,y,w,h} so it takes either
 *  a PaintedItem's plain bbox or a real BBox instance (Camera2.bbox) without
 *  needing PaintedItem.bbox to be upgraded to the BBox class. Used for
 *  per-frame viewport culling: a board with thousands of tracks/pads/vias
 *  redraws its ENTIRE scene every frame on the Canvas2D path (see
 *  KicadRenderSession.render's doc comment), so skipping items outside the
 *  current view is the difference between panning a big board at ~10fps and
 *  at 60. */
export function bboxesIntersect(a, b) {
    return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
}
export function shapeToBBox(shape) {
    switch (shape.type) {
        case 'rect':
            return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
        case 'circle':
            return { x: shape.cx - shape.r, y: shape.cy - shape.r, w: shape.r * 2, h: shape.r * 2 };
        case 'segment': {
            const half = shape.width / 2;
            return {
                x: Math.min(shape.x1, shape.x2) - half,
                y: Math.min(shape.y1, shape.y2) - half,
                w: Math.abs(shape.x2 - shape.x1) + shape.width,
                h: Math.abs(shape.y2 - shape.y1) + shape.width,
            };
        }
        case 'polygon': {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const p of shape.points) {
                minX = Math.min(minX, p.x);
                minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x);
                maxY = Math.max(maxY, p.y);
            }
            return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
        }
    }
}
// Below this, a click anywhere inside an unfilled shape's interior is
// forgiving enough to still feel clickable without covering real ground —
// matches this codebase's existing 0.15mm wire/pin click-tolerance
// convention (buildWireLike etc.), used here as a floor under strokeWidth/2
// rather than a fixed value, so a deliberately thick outline still gets a
// proportionally thicker hit band.
const MIN_HIT_TOLERANCE = 0.15;
// `tolerance` is additive with strokeWidth/2, matching real KiCad's own
// EDA_SHAPE::hitTest formula exactly: `maxdist = aAccuracy; if (width > 0)
// maxdist += width/2` (common/eda_shape.cpp, confirmed in the user's local
// checkout) — aAccuracy there is a SCREEN-PIXEL threshold converted to world
// units by the caller (eeschema's HITTEST_THRESHOLD_PIXELS, 5px, converted
// via `view->ToWorld()`), which is what makes real KiCad's click target stay
// a constant, comfortable SIZE ON SCREEN at any zoom level — a fixed
// world-space tolerance is either too tight when zoomed out or needlessly
// loose when zoomed in. KicadRenderSession.hitTestAtScreen computes and
// passes that pixel-derived tolerance; MIN_HIT_TOLERANCE stays as a floor
// so a caller that omits tolerance (passes 0) keeps exactly the old
// behavior rather than regressing to "must click the exact zero-width line".
function edgeTolerance(strokeWidth, tolerance) {
    return Math.max((strokeWidth ?? 0) / 2 + tolerance, MIN_HIT_TOLERANCE);
}
/** Distance from (x,y) to the nearest edge of a polyline/polygon — shared by
 * the unfilled edge-only test below and, promoted to exported (same reason
 * distanceToSegment was: avoid a second copy of this loop), by
 * SchematicPainter's rule-area-border dangling-forgiveness check. */
export function polygonEdgeDistance(points, closed, x, y) {
    let min = Infinity;
    for (let i = 0; i < points.length - 1; i++) {
        min = Math.min(min, distanceToSegment(x, y, points[i].x, points[i].y, points[i + 1].x, points[i + 1].y));
    }
    if (closed && points.length > 1) {
        const last = points[points.length - 1], first = points[0];
        min = Math.min(min, distanceToSegment(x, y, last.x, last.y, first.x, first.y));
    }
    return min;
}
/**
 * Precise point-in-shape test, used after the bbox broad-phase filter.
 *
 * `filled` defaults to true (unset === filled) so every EXISTING caller
 * that never set it (PCB pads/zones, filled symbol-body shapes, the
 * dangling-flag circles, …) keeps exactly its current whole-area hit-test
 * behavior — only callers that explicitly know their shape draws unfilled
 * opt into the edge-only test below.
 *
 * Ported from real KiCad's own EDA_SHAPE::hitTest (common/eda_shape.cpp,
 * confirmed in the user's local checkout): an UNFILLED closed shape
 * (rectangle/circle/poly with FILL_T::NO_FILL) hit-tests ONLY a thin band
 * around its own outline, not its whole enclosed area — otherwise any
 * schematic annotation box (a dashed "group these parts" rectangle, a rule
 * area, …) permanently steals clicks from everything visually inside it,
 * which is exactly the bug this fixes. `SCH_RULE_AREA` in real KiCad goes
 * further and overrides `IsFilledForHitTesting()` to ALWAYS return false
 * regardless of its own fill state — this app's buildRuleArea() does the
 * same by always passing `filled: false` rather than relying on rule areas
 * happening to always be unfilled in practice.
 *
 * `tolerance` (world units, default 0) is real KiCad's `aAccuracy` — see
 * edgeTolerance's comment. Filled shapes also get it (inflating the area
 * test outward), matching EDA_SHAPE::hitTest's own `arect.Inflate(aAccuracy)`
 * for box/area hit-tests — a filled shape is already an easy target, so this
 * mostly just keeps its OWN edge comfortably clickable too.
 */
export function shapeContainsPoint(shape, x, y, tolerance = 0) {
    switch (shape.type) {
        case 'rect': {
            if (shape.filled === false) {
                const tol = edgeTolerance(shape.strokeWidth, tolerance);
                const x2 = shape.x + shape.w, y2 = shape.y + shape.h;
                return distanceToSegment(x, y, shape.x, shape.y, x2, shape.y) <= tol
                    || distanceToSegment(x, y, x2, shape.y, x2, y2) <= tol
                    || distanceToSegment(x, y, x2, y2, shape.x, y2) <= tol
                    || distanceToSegment(x, y, shape.x, y2, shape.x, shape.y) <= tol;
            }
            return x >= shape.x - tolerance && x <= shape.x + shape.w + tolerance
                && y >= shape.y - tolerance && y <= shape.y + shape.h + tolerance;
        }
        case 'circle': {
            const dx = x - shape.cx;
            const dy = y - shape.cy;
            if (shape.filled === false) {
                const tol = edgeTolerance(shape.strokeWidth, tolerance);
                return Math.abs(Math.hypot(dx, dy) - shape.r) <= tol;
            }
            const rTol = shape.r + tolerance;
            return dx * dx + dy * dy <= rTol * rTol;
        }
        case 'segment':
            return distanceToSegment(x, y, shape.x1, shape.y1, shape.x2, shape.y2) <= shape.width / 2 + tolerance;
        case 'polygon': {
            if (shape.filled === false) {
                const tol = edgeTolerance(shape.strokeWidth, tolerance);
                return polygonEdgeDistance(shape.points, shape.closed, x, y) <= tol;
            }
            if (pointInPolygon(shape.points, x, y)) {
                return true;
            }
            return tolerance > 0 && polygonEdgeDistance(shape.points, shape.closed, x, y) <= tolerance;
        }
    }
}
export function distanceToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) {
        return Math.hypot(px - x1, py - y1);
    }
    let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    const closestX = x1 + t * dx;
    const closestY = y1 + t * dy;
    return Math.hypot(px - closestX, py - closestY);
}
// Standard ray-casting point-in-polygon test.
export function pointInPolygon(points, px, py) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const xi = points[i].x, yi = points[i].y;
        const xj = points[j].x, yj = points[j].y;
        const intersects = (yi > py) !== (yj > py) &&
            px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
        if (intersects) {
            inside = !inside;
        }
    }
    return inside;
}
const COPPER_CONTACT_EPSILON = 1e-8;
function isPolygonalShape(shape) {
    return shape.type === 'rect' || shape.type === 'polygon';
}
function polygonRing(shape) {
    return shape.type === 'polygon' ? shape.points : [
        { x: shape.x, y: shape.y }, { x: shape.x + shape.w, y: shape.y },
        { x: shape.x + shape.w, y: shape.y + shape.h }, { x: shape.x, y: shape.y + shape.h },
    ];
}
function pointOnSegment(point, a, b) {
    return distanceToSegment(point.x, point.y, a.x, a.y, b.x, b.y) <= COPPER_CONTACT_EPSILON;
}
function pointInOrOnPolygon(points, point) {
    if (pointInPolygon(points, point.x, point.y))
        return true;
    for (let i = 0; i < points.length; i++) {
        if (pointOnSegment(point, points[i], points[(i + 1) % points.length]))
            return true;
    }
    return false;
}
function segmentsTouch(a1, a2, b1, b2) {
    const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const aSide1 = cross(a1, a2, b1), aSide2 = cross(a1, a2, b2);
    const bSide1 = cross(b1, b2, a1), bSide2 = cross(b1, b2, a2);
    if (((aSide1 > COPPER_CONTACT_EPSILON && aSide2 < -COPPER_CONTACT_EPSILON)
        || (aSide1 < -COPPER_CONTACT_EPSILON && aSide2 > COPPER_CONTACT_EPSILON))
        && ((bSide1 > COPPER_CONTACT_EPSILON && bSide2 < -COPPER_CONTACT_EPSILON)
            || (bSide1 < -COPPER_CONTACT_EPSILON && bSide2 > COPPER_CONTACT_EPSILON)))
        return true;
    return pointOnSegment(a1, b1, b2) || pointOnSegment(a2, b1, b2)
        || pointOnSegment(b1, a1, a2) || pointOnSegment(b2, a1, a2);
}
function segmentDistance(a1, a2, b1, b2) {
    if (segmentsTouch(a1, a2, b1, b2))
        return 0;
    return Math.min(distanceToSegment(a1.x, a1.y, b1.x, b1.y, b2.x, b2.y), distanceToSegment(a2.x, a2.y, b1.x, b1.y, b2.x, b2.y), distanceToSegment(b1.x, b1.y, a1.x, a1.y, a2.x, a2.y), distanceToSegment(b2.x, b2.y, a1.x, a1.y, a2.x, a2.y));
}
function circleTouchesPolygon(circle, polygon) {
    const center = { x: circle.cx, y: circle.cy };
    if (pointInOrOnPolygon(polygon, center))
        return true;
    for (let i = 0; i < polygon.length; i++) {
        const point = polygon[i];
        if (Math.hypot(point.x - circle.cx, point.y - circle.cy) <= circle.r + COPPER_CONTACT_EPSILON)
            return true;
        if (distanceToSegment(circle.cx, circle.cy, point.x, point.y, polygon[(i + 1) % polygon.length].x, polygon[(i + 1) % polygon.length].y)
            <= circle.r + COPPER_CONTACT_EPSILON)
            return true;
    }
    return false;
}
function segmentTouchesPolygon(segment, polygon) {
    const a = { x: segment.x1, y: segment.y1 }, b = { x: segment.x2, y: segment.y2 };
    const radius = segment.width / 2 + COPPER_CONTACT_EPSILON;
    if (pointInOrOnPolygon(polygon, a) || pointInOrOnPolygon(polygon, b))
        return true;
    for (let i = 0; i < polygon.length; i++) {
        const p = polygon[i], q = polygon[(i + 1) % polygon.length];
        if (segmentDistance(a, b, p, q) <= radius)
            return true;
    }
    return false;
}
/** Precomputes per-edge bounding boxes for a polygon ring so the O(V_a·V_b)
 *  edge-overlap loop below can skip `segmentsTouch` on edge pairs whose
 *  bounding boxes cannot overlap — the dominant speedup for the connectivity
 *  hot path (BoardCopperGraph's shape-vs-shape pass), which spends most of its
 *  time in polygonsTouch for dense copper. Purely a fast path: every pair the
 *  edge-bbox rejects would have `segmentsTouch` return false anyway, so
 *  results are identical (verified against the previous implementation). */
function shapeEdges(poly) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        out.push({
            a, b,
            minX: a.x < b.x ? a.x : b.x,
            minY: a.y < b.y ? a.y : b.y,
            maxX: a.x > b.x ? a.x : b.x,
            maxY: a.y > b.y ? a.y : b.y,
        });
    }
    return out;
}
function polygonsTouch(a, b) {
    for (const point of a)
        if (pointInOrOnPolygon(b, point))
            return true;
    for (const point of b)
        if (pointInOrOnPolygon(a, point))
            return true;
    // Edge-overlap with an edge-bbox prefilter (~3x on dense polygons; the
    // O(V_a·V_b) loop only runs against genuinely near edges).
    const ea = shapeEdges(a), eb = shapeEdges(b);
    for (let i = 0; i < ea.length; i++) {
        const ai = ea[i];
        for (let j = 0; j < eb.length; j++) {
            const bj = eb[j];
            if (ai.maxX < bj.minX || bj.maxX < ai.minX
                || ai.maxY < bj.minY || bj.maxY < ai.minY)
                continue;
            if (segmentsTouch(ai.a, ai.b, bj.a, bj.b))
                return true;
        }
    }
    return false;
}
/** Exact primitive collision for the renderer's physical-copper shapes.
 * This deliberately treats tangent edges as touching: KiCad's connectivity
 * engine sees a pad/via whose annulus reaches a filled-zone boundary as one
 * electrical island, whereas a tessellated-circle approximation can leave a
 * false airwire at precisely that common board geometry. */
export function shapesOverlap(a, b) {
    const bboxA = shapeToBBox(a), bboxB = shapeToBBox(b);
    if (bboxA.x > bboxB.x + bboxB.w + COPPER_CONTACT_EPSILON
        || bboxA.x + bboxA.w + COPPER_CONTACT_EPSILON < bboxB.x
        || bboxA.y > bboxB.y + bboxB.h + COPPER_CONTACT_EPSILON
        || bboxA.y + bboxA.h + COPPER_CONTACT_EPSILON < bboxB.y)
        return false;
    if (a.type === 'circle' && b.type === 'circle') {
        return Math.hypot(a.cx - b.cx, a.cy - b.cy) <= a.r + b.r + COPPER_CONTACT_EPSILON;
    }
    if (a.type === 'circle' && b.type === 'segment') {
        return distanceToSegment(a.cx, a.cy, b.x1, b.y1, b.x2, b.y2) <= a.r + b.width / 2 + COPPER_CONTACT_EPSILON;
    }
    if (a.type === 'segment' && b.type === 'circle')
        return shapesOverlap(b, a);
    if (a.type === 'segment' && b.type === 'segment') {
        return segmentDistance({ x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }, { x: b.x1, y: b.y1 }, { x: b.x2, y: b.y2 })
            <= (a.width + b.width) / 2 + COPPER_CONTACT_EPSILON;
    }
    if (a.type === 'circle' && isPolygonalShape(b))
        return circleTouchesPolygon(a, polygonRing(b));
    if (b.type === 'circle' && isPolygonalShape(a))
        return circleTouchesPolygon(b, polygonRing(a));
    if (a.type === 'segment' && isPolygonalShape(b))
        return segmentTouchesPolygon(a, polygonRing(b));
    if (b.type === 'segment' && isPolygonalShape(a))
        return segmentTouchesPolygon(b, polygonRing(a));
    return isPolygonalShape(a) && isPolygonalShape(b) && polygonsTouch(polygonRing(a), polygonRing(b));
}
