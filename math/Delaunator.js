/**
 * Delaunator — fast 2D Delaunay triangulation for a set of points.
 *
 * Faithful TypeScript port of the mapbox "delaunator" algorithm, the exact
 * triangulator KiCad bundles as thirdparty/delaunator and feeds to its
 * ratsnest MST (see pcbnew/ratsnest/ratsnest_data.cpp's TRIANGULATOR_STATE).
 * Ported 1:1 from KiCad's vendored delaunator.cpp / delaunator.hpp (mapbox,
 * MIT-licensed) rather than re-derived, so the candidate-edge set — and
 * therefore the ratsnest the MST produces — matches KiCad's exactly.
 *
 * Attribution:
 *   - Source: KiCad thirdparty/delaunator/delaunator.cpp + delaunator.hpp
 *   - Upstream: mapbox/delaunator (https://github.com/mapbox/delaunator)
 *   - License: MIT (see apps/kicad/thirdparty/delaunator/LICENSE.MIT)
 *   - Adapted from C++ to TypeScript: method bodies translated verbatim,
 *     C++ std::vector / size_t idioms mapped to JS Array / number.
 *
 * Input `points` are ordinary { x, y } coordinates (mm). The output uses the
 * same indexing convention as delaunator.hpp: `triangles[i..i+2]` are the
 * three vertex indices of triangle i/3; `halfedges[e]` is the opposite
 * halfedge of edge e, or -1 for hull edges.
 */
export const INVALID_INDEX = -1;
function dist(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = ay - by;
    return dx * dx + dy * dy;
}
/** Circumradius-squared of (a,b,c); `ok:false` signals a degenerate triangle. */
function circumradiusSq(ax, ay, bx, by, cx, cy) {
    const dx = bx - ax;
    const dy = by - ay;
    const ex = cx - ax;
    const ey = cy - ay;
    const bl = dx * dx + dy * dy;
    const cl = ex * ex + ey * ey;
    const d = dx * ey - dy * ex;
    if (bl === 0 || cl === 0 || d === 0) {
        return { r: Number.POSITIVE_INFINITY, ok: false };
    }
    const x = (ey * bl - dy * cl) * 0.5 / d;
    const y = (dx * cl - ex * bl) * 0.5 / d;
    return { r: x * x + y * y, ok: true };
}
/** Orientation test (with the same relative-degeneracy guard as delaunator's
 *  `clockwise`, which defers to `false` for pathologically near-degenerate
 *  inputs so the incremental sweep stays within its numerical envelope). */
function clockwise(px, py, qx, qy, rx, ry) {
    const v0x = qx - px;
    const v0y = qy - py;
    const v1x = rx - px;
    const v1y = ry - py;
    const det = v0x * v1y - v0y * v1x;
    const mag = v0x * v0x + v0y * v0y + v1x * v1x + v1y * v1y;
    if (det === 0)
        return false;
    const reldet = Math.abs(mag / det);
    if (reldet > 1e14)
        return false;
    return det < 0;
}
function counterclockwise(px, py, qx, qy, rx, ry) {
    const v0x = qx - px;
    const v0y = qy - py;
    const v1x = rx - px;
    const v1y = ry - py;
    const det = v0x * v1y - v0y * v1x;
    const mag = v0x * v0x + v0y * v0y + v1x * v1x + v1y * v1y;
    if (det === 0)
        return false;
    const reldet = Math.abs(mag / det);
    if (reldet > 1e14)
        return false;
    return det > 0;
}
function circumcenter(ax, ay, bx, by, cx, cy) {
    const dx = bx - ax;
    const dy = by - ay;
    const ex = cx - ax;
    const ey = cy - ay;
    const bl = dx * dx + dy * dy;
    const cl = ex * ex + ey * ey;
    const d = dx * ey - dy * ex;
    return {
        x: ax + (ey * bl - dy * cl) * 0.5 / d,
        y: ay + (dx * cl - ex * bl) * 0.5 / d,
    };
}
/** In-circle test: is (px,py) strictly inside the circumcircle of (a,b,c)?
 *  The negative-signed-determinant form is delaunator's "illegal edge" test. */
function inCircle(ax, ay, bx, by, cx, cy, px, py) {
    const dx = ax - px;
    const dy = ay - py;
    const ex = bx - px;
    const ey = by - py;
    const fx = cx - px;
    const fy = cy - py;
    const ap = dx * dx + dy * dy;
    const bp = ex * ex + ey * ey;
    const cp = fx * fx + fy * fy;
    return (dx * (ey * cp - bp * fy) -
        dy * (ex * cp - bp * fx) +
        ap * (ex * fy - ey * fx)) < 0.0;
}
const EPSILON = Number.EPSILON;
function checkPtsEqual(x1, y1, x2, y2) {
    return Math.abs(x1 - x2) <= EPSILON && Math.abs(y1 - y2) <= EPSILON;
}
/** Monotonically increases with real angle, but needs no trig — [0..1). */
function pseudoAngle(dx, dy) {
    const p = dx / (Math.abs(dx) + Math.abs(dy));
    return (dy > 0.0 ? 3.0 - p : 1.0 + p) / 4.0;
}
/** Nearness test mirroring delaunator.hpp Point::equal (relates to how close
 *  two coordinates are relative to the overall point span before the
 *  determinant-based predicates lose robustness). */
function pointEqualRelative(ax, ay, bx, by, span) {
    const dx = ax - bx;
    const dy = ay - by;
    const d = dx * dx + dy * dy;
    return d / span < 1e-20;
}
/**
 * Computes a Delaunay triangulation of `points` — exactly the algorithm
 * KiCad's ratsnest uses (delaunator), including its near-duplicate handling
 * (coincident points collapse and are skipped). If the points cannot be
 * triangulated (fewer than 3 unique points, or all collinear), returns empty
 * `triangles`/`halfedges` rather than throwing; callers that need a real
 * triangulation should handle their own degenerate sets (as KiCad's
 * TRIANGULATOR_STATE does — see RN_NET::compute in ratsnest_data.cpp, which
 * chains collinear sets into a path instead).
 */
export function delaunator(points) {
    const n = points.length;
    if (n < 3) {
        return { triangles: [], halfedges: [] };
    }
    const coords = new Float64Array(n * 2);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < n; i++) {
        const x = points[i].x;
        const y = points[i].y;
        coords[2 * i] = x;
        coords[2 * i + 1] = y;
        if (x < minX)
            minX = x;
        if (y < minY)
            minY = y;
        if (x > maxX)
            maxX = x;
        if (y > maxY)
            maxY = y;
    }
    const width = maxX - minX;
    const height = maxY - minY;
    const span = width * width + height * height;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    // --- Seed triangle: point nearest the centroid, its nearest neighbor,
    // --- and the point forming the smallest circumcircle with those two.
    let i0 = 0;
    let minDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i++) {
        const d = dist(centerX, centerY, coords[2 * i], coords[2 * i + 1]);
        if (d < minDist) {
            i0 = i;
            minDist = d;
        }
    }
    const p0x = coords[2 * i0];
    const p0y = coords[2 * i0 + 1];
    let i1 = i0;
    minDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i++) {
        if (i === i0)
            continue;
        const d = dist(p0x, p0y, coords[2 * i], coords[2 * i + 1]);
        if (d < minDist && d > 0.0) {
            i1 = i;
            minDist = d;
        }
    }
    if (i1 === i0 || minDist === Number.POSITIVE_INFINITY) {
        // All points coincide (or only one unique point exists).
        return { triangles: [], halfedges: [] };
    }
    const p1x = coords[2 * i1];
    const p1y = coords[2 * i1 + 1];
    let i2 = i0;
    let minRadius = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i++) {
        if (i === i0 || i === i1)
            continue;
        const r = circumradiusSq(p0x, p0y, p1x, p1y, coords[2 * i], coords[2 * i + 1]);
        if (r.ok && r.r < minRadius) {
            i2 = i;
            minRadius = r.r;
        }
    }
    if (!(minRadius < Number.POSITIVE_INFINITY)) {
        // All points collinear — no triangulation.
        return { triangles: [], halfedges: [] };
    }
    const p2x = coords[2 * i2];
    const p2y = coords[2 * i2 + 1];
    if (counterclockwise(p0x, p0y, p1x, p1y, p2x, p2y)) {
        const tmp = i1;
        i1 = i2;
        i2 = tmp;
    }
    const i0x = p0x;
    const i0y = p0y;
    const i1x = coords[2 * i1];
    const i1y = coords[2 * i1 + 1];
    const i2x = coords[2 * i2];
    const i2y = coords[2 * i2 + 1];
    const center = circumcenter(i0x, i0y, i1x, i1y, i2x, i2y);
    // Sort point indices by distance from the seed triangle's circumcenter.
    const dists = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        dists[i] = dist(coords[2 * i], coords[2 * i + 1], center.x, center.y);
    }
    const ids = new Array(n);
    for (let i = 0; i < n; i++)
        ids[i] = i;
    ids.sort((a, b) => dists[a] - dists[b]);
    // --- Hull bookkeeping + edge hash table.
    const hashSize = Math.max(1, Math.ceil(Math.sqrt(n)));
    const hash = new Array(hashSize).fill(INVALID_INDEX);
    const hullPrev = new Array(n);
    const hullNext = new Array(n);
    const hullTri = new Array(n);
    let hullStart = i0;
    let hullSize = 3;
    hullNext[i0] = hullPrev[i2] = i1;
    hullNext[i1] = hullPrev[i0] = i2;
    hullNext[i2] = hullPrev[i1] = i0;
    hullTri[i0] = 0;
    hullTri[i1] = 1;
    hullTri[i2] = 2;
    const hashKey = (x, y) => {
        const dx = x - center.x;
        const dy = y - center.y;
        const idx = Math.floor(pseudoAngle(dx, dy) * hashSize);
        return idx === hashSize ? 0 : idx;
    };
    const triangles = [];
    const halfedges = [];
    function link(a, b) {
        if (a === halfedges.length) {
            halfedges.push(b);
        }
        else if (a < halfedges.length) {
            halfedges[a] = b;
        }
        else {
            throw new Error('Cannot link edge');
        }
        if (b !== INVALID_INDEX) {
            const s = halfedges.length;
            if (b === s) {
                halfedges.push(a);
            }
            else if (b < s) {
                halfedges[b] = a;
            }
            else {
                throw new Error('Cannot link edge');
            }
        }
    }
    function addTriangle(iA, iB, iC, a, b, c) {
        const t = triangles.length;
        triangles.push(iA, iB, iC);
        link(t, a);
        link(t + 1, b);
        link(t + 2, c);
        return t;
    }
    // Place the seed triangle first.
    addTriangle(i0, i1, i2, INVALID_INDEX, INVALID_INDEX, INVALID_INDEX);
    hash[hashKey(i0x, i0y)] = i0;
    hash[hashKey(i1x, i1y)] = i1;
    hash[hashKey(i2x, i2y)] = i2;
    // --- Incremental insertion + edge legalization (Delaunay flips).
    const edgeStack = [];
    function legalize(a) {
        let aa = a;
        let i = 0;
        edgeStack.length = 0;
        let ar = 0;
        for (;;) {
            const b = halfedges[aa];
            const a0 = 3 * Math.floor(aa / 3);
            ar = a0 + ((aa + 2) % 3);
            if (b === INVALID_INDEX) {
                if (i > 0) {
                    i--;
                    aa = edgeStack[i];
                    continue;
                }
                break;
            }
            const b0 = 3 * Math.floor(b / 3);
            const al = a0 + ((aa + 1) % 3);
            const bl = b0 + ((b + 2) % 3);
            const p0 = triangles[ar];
            const pr = triangles[aa];
            const pl = triangles[al];
            const p1 = triangles[bl];
            const illegal = inCircle(coords[2 * p0], coords[2 * p0 + 1], coords[2 * pr], coords[2 * pr + 1], coords[2 * pl], coords[2 * pl + 1], coords[2 * p1], coords[2 * p1 + 1]);
            if (illegal) {
                triangles[aa] = p1;
                triangles[b] = p0;
                const hbl = halfedges[bl];
                // Edge swapped on the other side of the hull (rare) — fix the
                // halfedge reference.
                if (hbl === INVALID_INDEX) {
                    let e = hullStart;
                    do {
                        if (hullTri[e] === bl) {
                            hullTri[e] = aa;
                            break;
                        }
                        e = hullPrev[e];
                    } while (e !== hullStart);
                }
                link(aa, hbl);
                link(b, halfedges[ar]);
                link(ar, bl);
                const br = b0 + ((b + 1) % 3);
                edgeStack[i] = br;
                i++;
            }
            else if (i > 0) {
                i--;
                aa = edgeStack[i];
                continue;
            }
            else {
                break;
            }
        }
        return ar;
    }
    // --- Iterate the sorted points, inserting each into the triangulation.
    let xp = NaN;
    let yp = NaN;
    for (let k = 0; k < n; k++) {
        const i = ids[k];
        const x = coords[2 * i];
        const y = coords[2 * i + 1];
        // Skip near-duplicate points.
        if (k > 0 && checkPtsEqual(x, y, xp, yp))
            continue;
        xp = x;
        yp = y;
        // Skip the seed triangle's own points.
        if (checkPtsEqual(x, y, i0x, i0y) ||
            checkPtsEqual(x, y, i1x, i1y) ||
            checkPtsEqual(x, y, i2x, i2y))
            continue;
        // Find a visible edge on the convex hull using the edge hash.
        const key = hashKey(x, y);
        let start = INVALID_INDEX;
        for (let j = 0; j < hashSize; j++) {
            start = hash[(key + j) % hashSize];
            if (start !== INVALID_INDEX && start !== hullNext[start])
                break;
        }
        start = hullPrev[start];
        let e = start;
        let q;
        // Advance until we find a hull edge where the point can be added.
        for (;;) {
            q = hullNext[e];
            if (pointEqualRelative(x, y, coords[2 * e], coords[2 * e + 1], span) ||
                pointEqualRelative(x, y, coords[2 * q], coords[2 * q + 1], span)) {
                e = INVALID_INDEX;
                break;
            }
            if (counterclockwise(x, y, coords[2 * e], coords[2 * e + 1], coords[2 * q], coords[2 * q + 1]))
                break;
            e = q;
            if (e === start) {
                e = INVALID_INDEX;
                break;
            }
        }
        // Likely a near-duplicate point; skip it.
        if (e === INVALID_INDEX)
            continue;
        // Add the first triangle from the point.
        let t = addTriangle(e, i, hullNext[e], INVALID_INDEX, INVALID_INDEX, hullTri[e]);
        hullTri[i] = legalize(t + 2);
        hullTri[e] = t;
        hullSize++;
        // Walk forward through the hull, adding triangles and flipping.
        let next = hullNext[e];
        for (;;) {
            q = hullNext[next];
            if (!counterclockwise(x, y, coords[2 * next], coords[2 * next + 1], coords[2 * q], coords[2 * q + 1]))
                break;
            t = addTriangle(next, i, q, hullTri[i], INVALID_INDEX, hullTri[next]);
            hullTri[i] = legalize(t + 2);
            hullNext[next] = next; // mark as removed
            hullSize--;
            next = q;
        }
        // Walk backward from the other side.
        if (e === start) {
            for (;;) {
                q = hullPrev[e];
                if (!counterclockwise(x, y, coords[2 * q], coords[2 * q + 1], coords[2 * e], coords[2 * e + 1]))
                    break;
                t = addTriangle(q, i, e, INVALID_INDEX, hullTri[e], hullTri[q]);
                legalize(t + 2);
                hullTri[q] = t;
                hullNext[e] = e; // mark as removed
                hullSize--;
                e = q;
            }
        }
        // Update the hull indices.
        hullPrev[i] = e;
        hullStart = e;
        hullPrev[next] = i;
        hullNext[e] = i;
        hullNext[i] = next;
        hash[hashKey(x, y)] = i;
        hash[hashKey(coords[2 * e], coords[2 * e + 1])] = e;
    }
    return { triangles, halfedges };
}
