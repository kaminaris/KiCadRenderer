import { distanceToSegment, pointInPolygon } from './PaintedShape';
function cellKey(x, y, cell) {
    return `${Math.floor(x / cell)}\u0000${Math.floor(y / cell)}`;
}
/** Exact segment-segment intersection/touch test (identical semantics to
 *  PaintedShape's private `segmentsTouch`, which isn't exported). */
function segmentsTouch(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
    const cross = (px1, py1, px2, py2, px3, py3) => (px2 - px1) * (py3 - py1) - (py2 - py1) * (px3 - px1);
    const aS1 = cross(ax1, ay1, ax2, ay2, bx1, by1), aS2 = cross(ax1, ay1, ax2, ay2, bx2, by2);
    const bS1 = cross(bx1, by1, bx2, by2, ax1, ay1), bS2 = cross(bx1, by1, bx2, by2, ax2, ay2);
    if (((aS1 > 1e-9 && aS2 < -1e-9) || (aS1 < -1e-9 && aS2 > 1e-9))
        && ((bS1 > 1e-9 && bS2 < -1e-9) || (bS1 < -1e-9 && bS2 > 1e-9)))
        return true;
    const onSeg = (px, py, x1, y1, x2, y2) => {
        const dx = x2 - x1, dy = y2 - y1, lsq = dx * dx + dy * dy;
        if (lsq === 0)
            return Math.hypot(px - x1, py - y1) <= 1e-9;
        const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lsq));
        return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy)) <= 1e-9;
    };
    return onSeg(ax1, ay1, bx1, by1, bx2, by2) || onSeg(ax2, ay2, bx1, by1, bx2, by2)
        || onSeg(bx1, by1, ax1, ay1, ax2, ay2) || onSeg(bx2, by2, ax1, ay1, ax2, ay2);
}
/**
 * Zone fills' point arrays are stable for the lifetime of a loaded scene
 * (BoardPainter.buildZoneFills builds them once; a drag commit only updates
 * the moved footprint's pads, never a pour's outline). So triangulating a
 * fill — O(V²) ear clipping, ~50ms at 800 vertices — is cached on the actual
 * `points` array, and repeated buildCopperGraph calls on the same scene reuse
 * the index instead of rebuilding it every time. The cache is a WeakMap keyed
 * by array identity, so it never leaks and is dropped when the scene is
 * rebuilt (a fresh points array is created).
 */
const zoneIndexCache = new WeakMap();
export function buildZoneFillIndex(points) {
    const cached = zoneIndexCache.get(points);
    if (cached) {
        return cached;
    }
    if (points.length < 3) {
        return null;
    }
    // Bbox.
    let minX = Number.POSITIVE_INFINITY, minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY, maxY = Number.NEGATIVE_INFINITY;
    for (const p of points) {
        if (p.x < minX)
            minX = p.x;
        if (p.y < minY)
            minY = p.y;
        if (p.x > maxX)
            maxX = p.x;
        if (p.y > maxY)
            maxY = p.y;
    }
    const bbox = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    if (!(bbox.w > 0) || !(bbox.h > 0)) {
        return null;
    }
    // A cell size chosen so the triangle grid stays roughly O(1) per cell even
    // for huge power-plane fills: a 9987-vertex fill tiled with ~10k triangles
    // over a 100x70mm bbox will otherwise pack a 2mm cell with ~30 candidate
    // triangles, turning every containsPoint into a ~50us barycentric sweep. By
    // sizing cells to the average triangle footprint we keep per-cell density
    // near 1. (The O(V²) ear-clipping cost is unchanged; this is only the
    // index resolution for the point/edge lookups.)
    const estCellsPerSide = Math.max(16, Math.ceil(Math.sqrt(points.length)));
    const triCellMM = Math.min(4, Math.max(0.25, Math.max(bbox.w, bbox.h) / estCellsPerSide));
    // Ear-clip the ring. If it fails (degenerate / self-intersecting), fill
    // via a plain pointInPolygon fallback so correctness never regresses.
    const triangles = triangulateRing(points);
    const grid = new Map();
    if (triangles && triangles.length > 0) {
        for (const tri of triangles) {
            const tril = {
                x0: tri[0].x, y0: tri[0].y, x1: tri[1].x, y1: tri[1].y, x2: tri[2].x, y2: tri[2].y,
                minX: 0, minY: 0, maxX: 0, maxY: 0,
            };
            tril.minX = Math.min(tril.x0, tril.x1, tril.x2);
            tril.minY = Math.min(tril.y0, tril.y1, tril.y2);
            tril.maxX = Math.max(tril.x0, tril.x1, tril.x2);
            tril.maxY = Math.max(tril.y0, tril.y1, tril.y2);
            for (let cx = Math.floor(tril.minX / triCellMM); cx <= Math.floor(tril.maxX / triCellMM); cx++) {
                for (let cy = Math.floor(tril.minY / triCellMM); cy <= Math.floor(tril.maxY / triCellMM); cy++) {
                    const key = `${cx}\u0000${cy}`;
                    const bucket = grid.get(key) ?? [];
                    bucket.push(tril);
                    grid.set(key, bucket);
                }
            }
        }
    }
    const hasTriangles = (triangles?.length ?? 0) > 0;
    function containsPointFromTriangles(x, y) {
        const bucket = grid.get(cellKey(x, y, triCellMM));
        // The triangulated fill exactly tiles the polygon, so an empty cell
        // (no triangle bbox covers this point) means the point is OUTSIDE —
        // it is never a bbox-only acceptance. (This was a real bug: falling
        // back to the outer bbox reject here returned true for concave
        // notches / holes inside the fill's bbox.)
        if (!bucket)
            return false;
        for (const t of bucket) {
            if (barycentricInTri(t, x, y))
                return true;
        }
        return false;
    }
    function outerBBoxReject(x, y) {
        return x >= bbox.x && x <= bbox.x + bbox.w && y >= bbox.y && y <= bbox.y + bbox.h;
    }
    // Grid-accelerated point-in-fill fallback (used when the outline couldn't be
    // triangulated — the huge power-plane fills below). A point is inside a cell
    // with no polygon edge crossing it iff the cell's center is inside, so we
    // pre-classify every non-boundary cell once and only fall back to the exact
    // pointInPolygon for boundary cells. This turns the O(V) pointInPolygon per
    // call into O(1) for the (overwhelmingly common) interior/outside probes.
    let fallbackGrid = null;
    function buildFallbackGrid() {
        const boundary = new Set();
        for (let i = 0; i < points.length; i++) {
            const a = points[i], b = points[(i + 1) % points.length];
            const eMinX = a.x < b.x ? a.x : b.x, eMaxX = a.x > b.x ? a.x : b.x;
            const eMinY = a.y < b.y ? a.y : b.y, eMaxY = a.y > b.y ? a.y : b.y;
            for (let cx = Math.floor(eMinX / triCellMM); cx <= Math.floor(eMaxX / triCellMM); cx++) {
                for (let cy = Math.floor(eMinY / triCellMM); cy <= Math.floor(eMaxY / triCellMM); cy++) {
                    boundary.add(`${cx}\u0000${cy}`);
                }
            }
        }
        const inside = new Set();
        const minCx = Math.floor(bbox.x / triCellMM), maxCx = Math.floor((bbox.x + bbox.w) / triCellMM);
        const minCy = Math.floor(bbox.y / triCellMM), maxCy = Math.floor((bbox.y + bbox.h) / triCellMM);
        for (let cx = minCx; cx <= maxCx; cx++) {
            for (let cy = minCy; cy <= maxCy; cy++) {
                const key = `${cx}\u0000${cy}`;
                if (boundary.has(key))
                    continue;
                const cxp = (cx + 0.5) * triCellMM, cyp = (cy + 0.5) * triCellMM;
                if (pointInPolygon(points, cxp, cyp))
                    inside.add(key);
            }
        }
        fallbackGrid = { cell: triCellMM, boundary, inside };
    }
    function containsPointFallback(x, y) {
        if (!outerBBoxReject(x, y))
            return false;
        if (!fallbackGrid) {
            // Only build the grid for large fills where O(V) per call would bite;
            // tiny/degenerate fills stay on the exact O(V) path (V is small).
            if (points.length >= 64)
                buildFallbackGrid();
            else
                fallbackGrid = null;
        }
        if (fallbackGrid) {
            const key = `${Math.floor(x / fallbackGrid.cell)}\u0000${Math.floor(y / fallbackGrid.cell)}`;
            if (fallbackGrid.boundary.has(key)) {
                // On/near the outline — exact ray-cast to stay correct.
                return pointInPolygon(points, x, y);
            }
            return fallbackGrid.inside.has(key);
        }
        return pointInPolygon(points, x, y);
    }
    function containsPoint(x, y) {
        if (!outerBBoxReject(x, y))
            return false;
        return hasTriangles ? containsPointFromTriangles(x, y) : containsPointFallback(x, y);
    }
    // Precompute the fill's outline edges (and their bboxes) indexed into the
    // uniform grid, so "does the other shape touch the pour" is a
    // near-neighbor edge-overlap test (KiCad's SHAPE::Collide over the zone
    // outline) rather than an O(V_fill) triangle sweep per item — which was the
    // dominant cost when many same-net tracks cross a large pour, and the
    // direct cause of the trace-carrying graph-build blowup in the zone pass.
    const outlineEdges = [];
    const edgeGrid = new Map();
    if (points.length >= 2) {
        for (let i = 0; i < points.length; i++) {
            const a = points[i], b = points[(i + 1) % points.length];
            const e = {
                a, b,
                minX: a.x < b.x ? a.x : b.x, minY: a.y < b.y ? a.y : b.y,
                maxX: a.x > b.x ? a.x : b.x, maxY: a.y > b.y ? a.y : b.y,
            };
            outlineEdges.push(e);
            for (let cx = Math.floor(e.minX / triCellMM); cx <= Math.floor(e.maxX / triCellMM); cx++) {
                for (let cy = Math.floor(e.minY / triCellMM); cy <= Math.floor(e.maxY / triCellMM); cy++) {
                    const key = `${cx}\u0000${cy}`;
                    const bkt = edgeGrid.get(key) ?? [];
                    bkt.push(e);
                    edgeGrid.set(key, bkt);
                }
            }
        }
    }
    function overlapsPolygon(other, closed) {
        // 1. Any vertex of `other` inside the fill => overlap.
        for (const p of other) {
            if (containsPoint(p.x, p.y))
                return true;
        }
        if (!hasTriangles && points.length < 3) {
            return false;
        }
        // 2. Any edge of `other` crossing the fill outline => overlap. Only
        //    fill edges in the other shape's cells are tested (edge bbox grid
        //    + per-edge bbox prefilter), mirroring KiCad's SHAPE::Collide over
        //    the zone outline.
        const otherBBox = bboxOfPoints(other);
        const minCx = Math.floor(otherBBox.x / triCellMM), maxCx = Math.floor((otherBBox.x + otherBBox.w) / triCellMM);
        const minCy = Math.floor(otherBBox.y / triCellMM), maxCy = Math.floor((otherBBox.y + otherBBox.h) / triCellMM);
        const m = other.length;
        const edgeSeen = new Set();
        for (let cx = minCx; cx <= maxCx; cx++) {
            for (let cy = minCy; cy <= maxCy; cy++) {
                for (const fe of edgeGrid.get(`${cx}\u0000${cy}`) ?? []) {
                    if (edgeSeen.has(fe))
                        continue;
                    edgeSeen.add(fe);
                    const edgeCount = closed ? m : m - 1;
                    for (let i = 0; i < edgeCount; i++) {
                        const a = other[i], b = other[(i + 1) % m];
                        const oMinX = a.x < b.x ? a.x : b.x, oMaxX = a.x > b.x ? a.x : b.x;
                        const oMinY = a.y < b.y ? a.y : b.y, oMaxY = a.y > b.y ? a.y : b.y;
                        if (fe.maxX < oMinX - 1e-9 || oMaxX < fe.minX - 1e-9
                            || fe.maxY < oMinY - 1e-9 || oMaxY < fe.minY - 1e-9)
                            continue;
                        if (segmentsTouch(a.x, a.y, b.x, b.y, fe.a.x, fe.a.y, fe.b.x, fe.b.y))
                            return true;
                    }
                }
            }
        }
        if (!hasTriangles) {
            // Untriangulatable fill — also test fill-vertex-in-other for a
            // shape that fully encloses a small fill island.
            for (const fp of points)
                if (pointInPolygon(other, fp.x, fp.y))
                    return true;
        }
        return false;
    }
    // Exact segment-vs-fill (honoring stroke width), mirroring PaintedShape's
    // segmentTouchesPolygon: endpoint in/on the fill, or the segment's stroked
    // body reaches a fill outline edge.
    const radius = (shapeSpaceWidth) => shapeSpaceWidth / 2 + 1e-9;
    function segmentTouches(x1, y1, x2, y2, width) {
        const r = radius(width);
        if (containsPoint(x1, y1) || containsPoint(x2, y2))
            return true;
        const segMinX = x1 < x2 ? x1 : x2, segMaxX = x1 > x2 ? x1 : x2;
        const segMinY = y1 < y2 ? y1 : y2, segMaxY = y1 > y2 ? y1 : y2;
        // Expand the cell range by the stroke radius so fill edges just across
        // a cell boundary (but within width/2 of the segment) are found.
        const minCx = Math.floor((segMinX - r) / triCellMM), maxCx = Math.floor((segMaxX + r) / triCellMM);
        const minCy = Math.floor((segMinY - r) / triCellMM), maxCy = Math.floor((segMaxY + r) / triCellMM);
        const seen = new Set();
        for (let cx = minCx; cx <= maxCx; cx++) {
            for (let cy = minCy; cy <= maxCy; cy++) {
                for (const fe of edgeGrid.get(`${cx}\u0000${cy}`) ?? []) {
                    if (seen.has(fe))
                        continue;
                    seen.add(fe);
                    if (fe.minX - r > segMaxX || segMinX > fe.maxX + r
                        || fe.minY - r > segMaxY || segMinY > fe.maxY + r)
                        continue;
                    // A crossing (segment goes through the fill outline) or the
                    // stroked body reaching the edge — mirror segmentTouchesPolygon.
                    if (segmentsTouch(x1, y1, x2, y2, fe.a.x, fe.a.y, fe.b.x, fe.b.y))
                        return true;
                    if (distanceToSegment(fe.a.x, fe.a.y, x1, y1, x2, y2) <= r)
                        return true;
                    if (distanceToSegment(fe.b.x, fe.b.y, x1, y1, x2, y2) <= r)
                        return true;
                    if (distanceToSegment(x1, y1, fe.a.x, fe.a.y, fe.b.x, fe.b.y) <= r)
                        return true;
                    if (distanceToSegment(x2, y2, fe.a.x, fe.a.y, fe.b.x, fe.b.y) <= r)
                        return true;
                }
            }
        }
        return false;
    }
    const index = { bbox, points, containsPoint, overlapsPolygon, segmentTouches };
    zoneIndexCache.set(points, index);
    return index;
}
function bboxOfPoints(pts) {
    let minX = Number.POSITIVE_INFINITY, minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY, maxY = Number.NEGATIVE_INFINITY;
    for (const p of pts) {
        if (p.x < minX)
            minX = p.x;
        if (p.y < minY)
            minY = p.y;
        if (p.x > maxX)
            maxX = p.x;
        if (p.y > maxY)
            maxY = p.y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
function barycentricInTri(t, px, py) {
    const v0x = t.x1 - t.x0, v0y = t.y1 - t.y0;
    const v1x = t.x2 - t.x0, v1y = t.y2 - t.y0;
    const v2x = px - t.x0, v2y = py - t.y0;
    const dot00 = v0x * v0x + v0y * v0y;
    const dot01 = v0x * v1x + v0y * v1y;
    const dot02 = v0x * v2x + v0y * v2y;
    const dot11 = v1x * v1x + v1y * v1y;
    const dot12 = v1x * v2x + v1y * v2y;
    const invDenom = 1 / (dot00 * dot11 - dot01 * dot01);
    const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
    const v = (dot00 * dot12 - dot01 * dot02) * invDenom;
    return u >= 0 && v >= 0 && u + v <= 1;
}
/**
 * Ear-clips a simple polygon ring. Returns an array of triangle vertex-index
 * triples, or null if the ring isn't a valid simple (possibly concave)
 * polygon — e.g. it self-intersects or is degenerate (a self-touching
 * keyhole-bridged fill from zone fracture) — in which case the caller falls
 * back to exact pointInPolygon. Includes the polygon's boundary (points on
 * the edge count as inside), matching pointInPolygon's on-edge semantics.
 */
function triangulateRing(pts) {
    const n = pts.length;
    if (n < 3)
        return null;
    // Quick self-intersection / duplicate detection: reject anything with
    // repeated vertices or obvious non-simple structure so ear clipping never
    // loops. (O(V²); V is a zone outline (~hundreds), fine.)
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (pts[i].x === pts[j].x && pts[i].y === pts[j].y) {
                return null; // duplicate vertex => likely self-touching
            }
        }
    }
    const indices = pts.map((_, i) => i);
    // Determine ring winding so the convex-ear test is orientation-correct.
    let signedArea = 0;
    for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        signedArea += a.x * b.y - b.x * a.y;
    }
    const isCCW = signedArea > 0; // + area => counter-clockwise
    const triangles = [];
    let guard = 0;
    const maxGuard = n * n * 2 + 64;
    while (indices.length > 3 && guard++ < maxGuard) {
        let earFound = false;
        for (let k = 0; k < indices.length; k++) {
            const i0 = indices[(k - 1 + indices.length) % indices.length];
            const i1 = indices[k];
            const i2 = indices[(k + 1) % indices.length];
            const a = pts[i0], b = pts[i1], c = pts[i2];
            const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
            if (Math.abs(cross) < 1e-9) {
                // Collinear — remove the middle point (it's redundant).
                indices.splice(k, 1);
                earFound = true;
                break;
            }
            // A convex ear is one whose turn matches the ring orientation.
            const convex = isCCW ? cross > 0 : cross < 0;
            if (!convex)
                continue; // reflex vertex, not an ear
            // Check no other vertex lies strictly inside triangle (a,b,c).
            let containsOther = false;
            for (const other of indices) {
                if (other === i0 || other === i1 || other === i2)
                    continue;
                if (pointInTriangleNum(a.x, a.y, b.x, b.y, c.x, c.y, pts[other].x, pts[other].y)) {
                    containsOther = true;
                    break;
                }
            }
            if (containsOther)
                continue;
            triangles.push([a, b, c]);
            indices.splice(k, 1);
            earFound = true;
            break;
        }
        if (!earFound) {
            return null; // e.g. self-intersecting ring
        }
    }
    if (indices.length === 3) {
        const a = pts[indices[0]], b = pts[indices[1]], c = pts[indices[2]];
        const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        if (cross !== 0) {
            triangles.push([a, b, c]);
        }
    }
    return triangles.length >= 1 ? triangles : null;
}
function pointInTriangleNum(ax, ay, bx, by, cx, cy, px, py) {
    const v0x = bx - ax, v0y = by - ay;
    const v1x = cx - ax, v1y = cy - ay;
    const v2x = px - ax, v2y = py - ay;
    const dot00 = v0x * v0x + v0y * v0y;
    const dot01 = v0x * v1x + v0y * v1y;
    const dot02 = v0x * v2x + v0y * v2y;
    const dot11 = v1x * v1x + v1y * v1y;
    const dot12 = v1x * v2x + v1y * v2y;
    const invDenom = 1 / (dot00 * dot11 - dot01 * dot01);
    const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
    const v = (dot00 * dot12 - dot01 * dot02) * invDenom;
    return u > 0 && v > 0 && u + v < 1;
}
