import { Vec2 } from '../../math/Vec2';
import { distanceToSegment, pointInPolygon, shapeToBBox, shapesOverlap } from '../PaintedShape';
import { buildZoneFillIndex } from '../ZoneFillIndex';
/**
 * KiCad connectivity design adaptation. Based on pcbnew/connectivity/
 * connectivity_algo.cpp, connectivity_items.h, and connectivity_rtree.h
 * (KiCad Developers; GPLv2-or-later). This TypeScript implementation keeps
 * KiOnline's scene adapter and union-find representation, while adopting
 * KiCad's item-level, layer-aware copper-contact model and per-filled-zone
 * island semantics. Distributed under GPLv3-or-later with this derivative.
 */
const CONNECT_EPSILON_MM = 0.02;
const CONNECT_GRID_CELL_MM = 2;
/**
 * Builds the board's point-level copper connectivity graph: nodes at every
 * track/arc endpoint, pad center, and via per-layer tap, joined by a
 * union-find wherever copper actually touches. Copper connectivity is
 * layer-aware: same-coordinate F.Cu/B.Cu tracks are not joined unless a
 * through pad or via explicitly unions those layer nodes.
 *
 * Shared by buildBoardRatsnest (paint/BoardRatsnest.ts — only needs the
 * final island grouping, via find(), to MST-join disconnected components
 * into airwires) and KicadRenderSession.expandBoardConnection (needs the
 * full node/segment adjacency for its point-by-point "Select/Expand
 * Connection" walk). Extracted from what was previously the first half of
 * buildBoardRatsnest — a mechanical move, not a rewrite of the connectivity
 * rules themselves.
 *
 * `netFilter`, when given, skips every item whose net isn't in the set —
 * used during a footprint drag to recompute ratsnest for just the nets that
 * moved (see KicadRenderSession's incremental board-rebuild path) instead
 * of the whole board every frame. Still does one O(scene size) pass to find
 * those items (a cheap property-read + Set.has per item), just skips the
 * expensive union-find/nearest-neighbor work for everything else.
 */
export function buildCopperGraph(scene, netFilter) {
    const activeNetFilter = netFilter ? expandNetFilterForJumpers(scene, netFilter) : undefined;
    const nodes = [];
    const segments = [];
    // One actual copper item per layer, rather than one entry for every
    // topological endpoint.  Tracks have two endpoint nodes but only one
    // physical copper body; indexing both multiplied dense-board collision
    // candidates by four without discovering any extra contacts.
    const copperContacts = [];
    const nodeCopperShapes = new Map();
    const parent = [];
    const adjacency = [];
    const addNode = (point, layer, netId, itemId, itemKind) => {
        const index = nodes.length;
        nodes.push({ point, layer, netId, itemId, itemKind });
        parent.push(index);
        adjacency.push([]);
        return index;
    };
    const addCopperContact = (node, shape) => {
        const shapes = nodeCopperShapes.get(node);
        if (shapes)
            shapes.push(shape);
        else
            nodeCopperShapes.set(node, [shape]);
        copperContacts.push({ node, shape });
    };
    const find = (index) => {
        while (parent[index] !== index) {
            parent[index] = parent[parent[index]];
            index = parent[index];
        }
        return index;
    };
    const union = (a, b) => {
        // Guarded, unlike a bare union-find union: the touching-copper pass
        // below tests every node against every segment on its net+layer (not
        // spatially bucketed by position), so a segment's own endpoint is
        // always distance-0 from itself — union(a, a) and repeated union(a,
        // b) calls for an already-connected pair are both routine, harmless
        // no-ops for a plain union-find, but would otherwise leave spurious
        // self-loops/duplicate edges in the adjacency list, inflating
        // expandBoardConnection's junction "branch count" and causing it to
        // stop expanding partway through a plain straight run of track.
        if (a !== b && !adjacency[a].includes(b)) {
            adjacency[a].push(b);
            adjacency[b].push(a);
        }
        const ra = find(a), rb = find(b);
        if (ra !== rb)
            parent[rb] = ra;
    };
    const copperLayers = scene.copperLayerStack.length > 0
        ? scene.copperLayerStack
        : scene.layersPresent.filter(layer => layer.endsWith('.Cu'));
    const padNodes = new Map();
    const footprintPadNodes = new Map();
    // Iterates every layer-bucket item, not just scene.hitTestItems — track
    // ARCS (length-tuning/meander rounded corners) are deliberately not
    // hit-testable (see buildTrackArc's doc comment) but still need to
    // participate in connectivity, so hitTestItems alone would silently
    // treat every meander as a chain of disconnected islands.
    for (const items of scene.layerBuckets.values()) {
        for (const item of items) {
            const netId = item.netId ?? null;
            if (netId === null || netId <= 0)
                continue;
            if (activeNetFilter && !activeNetFilter.has(netId))
                continue;
            if (item.kind === 'track' && item.shape.type === 'segment') {
                const a = addNode(new Vec2(item.shape.x1, item.shape.y1), item.layer, netId, item.id, 'track');
                const b = addNode(new Vec2(item.shape.x2, item.shape.y2), item.layer, netId, item.id, 'track');
                addCopperContact(a, item.shape);
                union(a, b);
                segments.push({ a, b, layer: item.layer, netId, width: item.shape.width });
            }
            else if (item.kind === 'track' && item.shape.type === 'circle'
                && typeof item.element?.getStartMidEnd === 'function') {
                // A track arc's endpoints are its real connection points (the
                // rendered shape is a full-circle placeholder — see buildTrackArc)
                // — getStartMidEnd() gives those directly, no trig round-trip.
                const { start, end } = item.element.getStartMidEnd();
                const width = typeof item.element.getWidth === 'function' ? item.element.getWidth() : 0.25;
                const a = addNode(new Vec2(start.x, start.y), item.layer, netId, item.id, 'track');
                const b = addNode(new Vec2(end.x, end.y), item.layer, netId, item.id, 'track');
                if (typeof item.element.getArcCenterRadiusAngles === 'function') {
                    const arcShape = sweptArcShape(item.element.getArcCenterRadiusAngles(), width);
                    if (arcShape) {
                        addCopperContact(a, arcShape);
                    }
                }
                union(a, b);
                segments.push({ a, b, layer: item.layer, netId, width });
            }
            else if (item.kind === 'pad' && item.layer.endsWith('.Cu')) {
                const index = addNode(centerOf(item), item.layer, netId, item.id, 'pad');
                addCopperContact(index, item.shape);
                const siblings = padNodes.get(item.element) ?? [];
                for (const sibling of siblings)
                    union(index, sibling);
                siblings.push(index);
                padNodes.set(item.element, siblings);
                const footprint = item.element?.parent;
                const padNumber = String(item.element?.padNumber ?? '');
                if (footprint && padNumber) {
                    const byNumber = footprintPadNodes.get(footprint) ?? new Map();
                    const padLayerNodes = byNumber.get(padNumber) ?? [];
                    padLayerNodes.push(index);
                    byNumber.set(padNumber, padLayerNodes);
                    footprintPadNodes.set(footprint, byNumber);
                }
            }
            else if (item.kind === 'graphic' && item.layer.endsWith('.Cu')) {
                const index = addNode(centerOf(item), item.layer, netId, item.id, 'graphic');
                for (const shape of graphicCopperShapes(item))
                    addCopperContact(index, shape);
            }
            else if (item.kind === 'via') {
                const requested = typeof item.element?.getLayers === 'function'
                    ? item.element.getLayers() : ['F.Cu', 'B.Cu'];
                // A via's plated barrel physically touches every copper layer
                // between its two named layers, not just those two — a normal
                // through via names only "F.Cu"/"B.Cu" yet still bridges every
                // internal plane in between (this was the root cause of an
                // internal power plane like In3.Cu looking entirely unconnected:
                // through-vias never got a node on it). Blind/buried vias name
                // their real (non-F/B) endpoints, so this still correctly limits
                // them to just the layers they actually span.
                const explicit = requested.flatMap(layer => layer === '*.Cu' ? copperLayers : [layer])
                    .filter(layer => copperLayers.includes(layer));
                const indices = explicit.map(layer => copperLayers.indexOf(layer)).filter(i => i >= 0);
                const layers = indices.length >= 2
                    ? copperLayers.slice(Math.min(...indices), Math.max(...indices) + 1)
                    : explicit;
                const viaNodes = layers.map(layer => {
                    const index = addNode(centerOf(item), layer, netId, item.id, 'via');
                    addCopperContact(index, item.shape);
                    return index;
                });
                for (let i = 1; i < viaNodes.length; i++)
                    union(viaNodes[0], viaNodes[i]);
            }
        }
    }
    // KiCad's `updateJumperPads()` explicitly joins declared net-tie pad
    // groups (and intentionally duplicated pad numbers) after it has built
    // ordinary physical contacts.  These links cross net IDs by design, so
    // they cannot go through the net/layer shape index below.
    for (const [footprint, padsByNumber] of footprintPadNodes) {
        if (footprint.getSimpleChildValue?.('duplicate_pad_numbers_are_jumpers') === true) {
            for (const nodesForNumber of padsByNumber.values())
                unionAll(nodesForNumber, union);
        }
        for (const group of footprintNetTieGroups(footprint)) {
            const groupNodes = group.flatMap(number => padsByNumber.get(number) ?? []);
            unionAll(groupNodes, union);
        }
    }
    // Join touching copper on the same layer, including T-branches whose
    // endpoint lands in the middle of an existing track. The former
    // node-by-every-node / node-by-every-segment pass was the dominant cost
    // when refreshing a dense net's ratsnest during a drag. The same net/layer
    // is now additionally spatially hashed, so a node only tests nearby
    // candidates while preserving the exact distance tests below.
    const nodeBuckets = new Map();
    const nodeGrid = new Map();
    const segmentGrid = new Map();
    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        const key = bucketKey(node.netId, node.layer);
        const bucket = nodeBuckets.get(key) ?? [];
        bucket.push(index);
        nodeBuckets.set(key, bucket);
        // Graphics have a bookkeeping centre only; unlike a pad, via, or
        // track endpoint it is never an electrical anchor.  Indexing it here
        // falsely joined a hollow net-tied rectangle to a pad drawn inside its
        // empty interior. Their real stroked/fill geometry is handled by the
        // physical-shape pass above.
        if (node.itemKind !== 'graphic') {
            const cell = gridCell(node.point.x, node.point.y);
            pushGridEntry(nodeGrid, gridKey(key, cell.x, cell.y), index);
        }
    }
    for (let index = 0; index < segments.length; index++) {
        const segment = segments[index];
        const key = bucketKey(segment.netId, segment.layer);
        const a = nodes[segment.a].point;
        const b = nodes[segment.b].point;
        const reach = segment.width / 2 + CONNECT_EPSILON_MM;
        const min = gridCell(Math.min(a.x, b.x) - reach, Math.min(a.y, b.y) - reach);
        const max = gridCell(Math.max(a.x, b.x) + reach, Math.max(a.y, b.y) + reach);
        for (let x = min.x; x <= max.x; x++) {
            for (let y = min.y; y <= max.y; y++) {
                pushGridEntry(segmentGrid, gridKey(key, x, y), index);
            }
        }
    }
    // KiCad's CN_ITEM search is item-vs-item, not a matrix of special-case
    // pad/via/track rules.  Index every real copper shape by its bbox, then
    // collide same-net, same-layer candidates through one shared path.
    // Precompute each contact's bbox once so the (majority) non-overlapping
    // candidate pairs are rejected by a cheap bbox test without re-deriving
    // the bbox inside shapesOverlap on every call — the dominant per-pair cost
    // on dense same-net copper.
    const contactBboxes = new Array(copperContacts.length);
    const shapeGrid = new Map();
    for (let contactIndex = 0; contactIndex < copperContacts.length; contactIndex++) {
        const { node: index, shape } = copperContacts[contactIndex];
        const node = nodes[index];
        const bbox = shapeToBBox(shape);
        contactBboxes[contactIndex] = bbox;
        const min = gridCell(bbox.x, bbox.y), max = gridCell(bbox.x + bbox.w, bbox.y + bbox.h);
        const key = bucketKey(node.netId, node.layer);
        for (let x = min.x; x <= max.x; x++)
            for (let y = min.y; y <= max.y; y++)
                pushGridEntry(shapeGrid, gridKey(key, x, y), contactIndex);
    }
    const seenShapes = new Uint32Array(copperContacts.length);
    let shapeVisit = 0;
    for (let contactIndex = 0; contactIndex < copperContacts.length; contactIndex++) {
        const { node: index, shape } = copperContacts[contactIndex];
        const node = nodes[index];
        const bbox = contactBboxes[contactIndex], min = gridCell(bbox.x, bbox.y), max = gridCell(bbox.x + bbox.w, bbox.y + bbox.h);
        const key = bucketKey(node.netId, node.layer);
        shapeVisit++;
        for (let x = min.x; x <= max.x; x++)
            for (let y = min.y; y <= max.y; y++)
                for (const otherContactIndex of shapeGrid.get(gridKey(key, x, y)) ?? []) {
                    if (otherContactIndex <= contactIndex)
                        continue;
                    if (seenShapes[otherContactIndex] === shapeVisit)
                        continue;
                    seenShapes[otherContactIndex] = shapeVisit;
                    const other = copperContacts[otherContactIndex];
                    if (nodes[other.node].itemId === node.itemId)
                        continue;
                    const otherBbox = contactBboxes[otherContactIndex];
                    // BBox reject at least as permissive as shapesOverlap's own (using
                    // the connectivity epsilon, which is >> PaintedShape's 1e-8) so we
                    // never discard a pair shapesOverlap would accept.
                    if (bbox.x > otherBbox.x + otherBbox.w + CONNECT_EPSILON_MM
                        || bbox.x + bbox.w + CONNECT_EPSILON_MM < otherBbox.x
                        || bbox.y > otherBbox.y + otherBbox.h + CONNECT_EPSILON_MM
                        || bbox.y + bbox.h + CONNECT_EPSILON_MM < otherBbox.y)
                        continue;
                    if (shapesOverlap(shape, other.shape))
                        union(index, other.node);
                }
    }
    const seenSegments = new Uint32Array(segments.length);
    let segmentVisit = 0;
    for (const [key, bucketNodes] of nodeBuckets) {
        for (const nodeIndex of bucketNodes) {
            const node = nodes[nodeIndex];
            if (node.itemKind === 'graphic')
                continue;
            const cell = gridCell(node.point.x, node.point.y);
            for (let x = cell.x - 1; x <= cell.x + 1; x++) {
                for (let y = cell.y - 1; y <= cell.y + 1; y++) {
                    for (const otherIndex of nodeGrid.get(gridKey(key, x, y)) ?? []) {
                        if (otherIndex <= nodeIndex)
                            continue;
                        if (distance(nodes[nodeIndex].point, nodes[otherIndex].point) <= CONNECT_EPSILON_MM) {
                            union(nodeIndex, otherIndex);
                        }
                    }
                }
            }
            segmentVisit++;
            for (const segmentIndex of segmentGrid.get(gridKey(key, cell.x, cell.y)) ?? []) {
                if (seenSegments[segmentIndex] === segmentVisit)
                    continue;
                seenSegments[segmentIndex] = segmentVisit;
                const segment = segments[segmentIndex];
                const a = nodes[segment.a].point, b = nodes[segment.b].point;
                if (distanceToSegment(node.point.x, node.point.y, a.x, a.y, b.x, b.y) <= segment.width / 2 + CONNECT_EPSILON_MM) {
                    // Union to whichever of the segment's own two endpoint
                    // nodes this point actually coincides with — unioning to
                    // segment.a unconditionally (regardless of which end the
                    // touching point is really at) created a spurious
                    // adjacency edge to a node one hop further away than the
                    // real touch, inflating isTrackStop's branch-count check
                    // at ordinary 2-degree joints and truncating
                    // assembleTrackLine/expandBoardConnection's walk almost
                    // at random depending on which way each segment happened
                    // to be authored in the file (root-caused against a real
                    // user board where dragging a track body silently
                    // stopped the assembled line mid-chain). A touch that
                    // lands in the segment's true middle (neither end) is a
                    // genuine T-branch, so it unions to both ends — the
                    // through-track stays one electrical island either way,
                    // but the branch tap is now a real 3-way point instead of
                    // being silently merged into whichever end happened to
                    // be "a".
                    const distA = distance(node.point, a), distB = distance(node.point, b);
                    if (distA <= CONNECT_EPSILON_MM) {
                        union(nodeIndex, segment.a);
                    }
                    else if (distB <= CONNECT_EPSILON_MM) {
                        union(nodeIndex, segment.b);
                    }
                    else {
                        union(nodeIndex, segment.a);
                        union(nodeIndex, segment.b);
                    }
                }
            }
        }
    }
    // Zone-fill connectivity: a copper pour joins every same-net pad/via/
    // track on the layer(s) it pours onto, exactly like touching copper —
    // this is the dominant connection for a GND/power plane, which is
    // usually poured rather than individually traced to every pad. Tested
    // against the zone's own bucket-matched nodes only (cheap: nodeBuckets
    // is already keyed by net+layer).  Each ZoneFillRegion is an actual
    // filled island, never the zone's authored outline.
    //
    // Each fill is triangulated once into a spatial index (ZoneFillIndex,
    // mirroring KiCad's CN_ZONE_LAYER::BuildRTree) so "does this node/edge
    // touch the pour" is a grid triangle lookup — O(1)-ish — instead of the
    // previous O(fill_vertices) pointInPolygon + polygon-vs-polygon sweep
    // over every same-net node, which was the dominant cost on zoned boards.
    const zoneIndexes = new Map();
    const zoneContacts = [];
    for (const fill of scene.zoneFills) {
        if (activeNetFilter && !activeNetFilter.has(fill.netId))
            continue;
        const key = bucketKey(fill.netId, fill.layer);
        const bucketNodes = nodeBuckets.get(key);
        if (!bucketNodes)
            continue;
        const index = buildZoneFillIndex(fill.points);
        // A degenerate fill (or one that can't be triangulated) still
        // connects via the O(V) pointInPolygon fallback inside ZoneFillIndex's
        // containsPoint/overlapsPolygon, so correctness never regresses.
        if (index)
            zoneIndexes.set(fill, index);
        // KiCad only tests an item against a zone when their bboxes are near
        // (its R-tree FindNearby). Cull to that here: an item far outside the
        // pour's bounding box (and whose shapes' bboxes don't reach it) can
        // never touch it, so it is skipped instead of point-tested.
        const fillBBox = index ? index.bbox : bboxOfPointsSimple(fill.points);
        const reach = CONNECT_EPSILON_MM;
        let first = null;
        for (const nodeIndex of bucketNodes) {
            const point = nodes[nodeIndex].point;
            // Near-cull (R-tree-style): skip if neither the anchor point nor any
            // of its copper shapes' bboxes can reach the fill bbox this pass.
            if (point.x < fillBBox.x - reach || point.x > fillBBox.x + fillBBox.w + reach
                || point.y < fillBBox.y - reach || point.y > fillBBox.y + fillBBox.h + reach) {
                const copperShapes0 = nodeCopperShapes.get(nodeIndex);
                let near = false;
                if (copperShapes0) {
                    for (const s of copperShapes0) {
                        const sb = shapeToBBox(s);
                        if (!(sb.x > fillBBox.x + fillBBox.w + reach
                            || sb.x + sb.w + reach < fillBBox.x
                            || sb.y > fillBBox.y + fillBBox.h + reach
                            || sb.y + sb.h + reach < fillBBox.y)) {
                            near = true;
                            break;
                        }
                    }
                }
                if (!near)
                    continue;
            }
            // A via, pad, or track can legitimately meet a poured island while
            // its anchor centre lies outside it (common at zone edges).  KiCad
            // asks its CN_ZONE_LAYER to collide the item's actual shape; this
            // adaptation keeps that same item-level rule in nodeCopperShapes.
            // index.containsPoint is a fast triangle lookup; the node-copper
            // shape fallback uses index.overlapsPolygon (also triangle-backed)
            // instead of shapesOverlap against the whole fill polygon.
            const copperShapes = nodeCopperShapes.get(nodeIndex);
            let touches = false;
            if (index) {
                if (index.containsPoint(point.x, point.y))
                    touches = true;
                else if (copperShapes) {
                    for (const shape of copperShapes) {
                        if (shapeOverlapsZone(shape, index)) {
                            touches = true;
                            break;
                        }
                    }
                }
            }
            else {
                // No usable zone index (e.g. zero-area/degenerate fill): fall
                // back to the exact point-in-polygon / polygon-overlap path so
                // a weird fill never changes connectivity.
                if (pointInPolygon(fill.points, point.x, point.y))
                    touches = true;
                else if (copperShapes && copperShapes.some(shape => shapesOverlap(fillShapeOf(fill), shape)))
                    touches = true;
            }
            if (!touches)
                continue;
            if (first === null)
                first = nodeIndex;
            else
                union(first, nodeIndex);
        }
        zoneContacts.push({ fill, node: first });
    }
    // KiCad indexes every filled-zone island as a normal connectivity item.
    // Consequently two same-net islands that physically touch are one copper
    // island even if no pad, via, or track happens to provide an anchor at
    // their seam. The contact representatives above let us express that in
    // this anchor-based graph without inventing visible ratsnest endpoints.
    const zoneGrid = new Map();
    for (let index = 0; index < zoneContacts.length; index++) {
        const contact = zoneContacts[index];
        if (contact.node === null)
            continue;
        const bbox = shapeToBBox({ type: 'polygon', points: contact.fill.points, closed: true });
        const min = gridCell(bbox.x, bbox.y);
        const max = gridCell(bbox.x + bbox.w, bbox.y + bbox.h);
        const key = bucketKey(contact.fill.netId, contact.fill.layer);
        for (let x = min.x; x <= max.x; x++)
            for (let y = min.y; y <= max.y; y++) {
                pushGridEntry(zoneGrid, gridKey(key, x, y), index);
            }
    }
    const seenZoneContacts = new Uint32Array(zoneContacts.length);
    let zoneVisit = 0;
    for (let i = 0; i < zoneContacts.length; i++) {
        const a = zoneContacts[i];
        if (a.node === null)
            continue;
        const shapeA = { type: 'polygon', points: a.fill.points, closed: true };
        const bbox = shapeToBBox(shapeA);
        const min = gridCell(bbox.x, bbox.y), max = gridCell(bbox.x + bbox.w, bbox.y + bbox.h);
        zoneVisit++;
        const indexA = zoneIndexes.get(a.fill);
        for (let x = min.x; x <= max.x; x++)
            for (let y = min.y; y <= max.y; y++)
                for (const j of zoneGrid.get(gridKey(bucketKey(a.fill.netId, a.fill.layer), x, y)) ?? []) {
                    if (j <= i || seenZoneContacts[j] === zoneVisit)
                        continue;
                    seenZoneContacts[j] = zoneVisit;
                    const b = zoneContacts[j];
                    if (b.node === null)
                        continue;
                    // Zone-zone: use KiCad's checkZoneZoneConnection approach — two
                    // same-net fills touch if any vertex of one lies inside the other
                    // (fast triangle-R-tree ContainsPoint), so a large fill is never
                    // polygon-overlap-tested against another. On this board the bboxes
                    // of the 81 power-plane fills overlap heavily; the previous
                    // overlapsPolygon made this the dominant cost (~1s).
                    const indexB = zoneIndexes.get(b.fill);
                    let overlap = false;
                    if (indexA && indexB) {
                        if (a.fill.points.length <= b.fill.points.length) {
                            for (const p of a.fill.points)
                                if (indexB.containsPoint(p.x, p.y)) {
                                    overlap = true;
                                    break;
                                }
                            if (!overlap)
                                for (const p of b.fill.points)
                                    if (indexA.containsPoint(p.x, p.y)) {
                                        overlap = true;
                                        break;
                                    }
                        }
                        else {
                            for (const p of b.fill.points)
                                if (indexA.containsPoint(p.x, p.y)) {
                                    overlap = true;
                                    break;
                                }
                            if (!overlap)
                                for (const p of a.fill.points)
                                    if (indexB.containsPoint(p.x, p.y)) {
                                        overlap = true;
                                        break;
                                    }
                        }
                    }
                    else {
                        overlap = shapesOverlap(shapeA, { type: 'polygon', points: b.fill.points, closed: true });
                    }
                    if (overlap)
                        union(a.node, b.node);
                }
    }
    return { nodes, segments, find, adjacent: index => adjacency[index] ?? [] };
}
/** Returns a polygon `PaintedShape` for a zone fill region (used by the
 *  no-index fallback so a degenerately-shaped fill still connects via the
 *  exact polygon-overlap path). */
function fillShapeOf(fill) {
    return { type: 'polygon', points: fill.points, closed: true };
}
/**
 * Builds a minimal TRACK-ONLY adjacency graph: nodes at every track/arc
 * endpoint, unioned where two tracks' endpoints physically touch (same net,
 * same layer, within CONNECT_EPSILON_MM). Pads, vias, graphics and zone fills
 * are deliberately omitted.
 *
 * This is what walking a connected track chain needs and nothing more — the
 * full `buildCopperGraph` (which also builds pad/via/zone connectivity) is
 * orders of magnitude heavier on a zoned board, and assembleTrackLine triggers
 * it on every mouse-down just to find the chain a clicked segment belongs to.
 * KiCad never rebuilds full connectivity to walk a track: it queries the
 * prebuilt topology. Mirroring that, this scoped builder gives the same
 * chain-walk result (track-to-track contact is the only thing a chain walk
 * depends on) without paying for the board-wide copper graphs.
 *
 * `adjacent` reflects only track-track contacts, so `walkTrackChainOutward` /
 * `isTrackChainStop` see track nodes only and stop naturally at chain ends.
 */
export function buildTrackChainGraph(scene) {
    const nodes = [];
    const segments = [];
    const adjacency = [];
    const parent = [];
    const addNode = (point, layer, netId, itemId) => {
        const index = nodes.length;
        nodes.push({ point, layer, netId, itemId, itemKind: 'track' });
        parent.push(index);
        adjacency.push([]);
        return index;
    };
    const find = (index) => {
        while (parent[index] !== index) {
            parent[index] = parent[parent[index]];
            index = parent[index];
        }
        return index;
    };
    const union = (a, b) => {
        if (a !== b && !adjacency[a].includes(b)) {
            adjacency[a].push(b);
            adjacency[b].push(a);
        }
        const ra = find(a), rb = find(b);
        if (ra !== rb)
            parent[rb] = ra;
    };
    // Index track endpoints by (net, layer, grid cell) so touching endpoints
    // are found in near-constant time instead of pairwise.
    const endpointGrid = new Map();
    for (const items of scene.layerBuckets.values()) {
        for (const item of items) {
            if (item.kind !== 'track' || item.netId == null || item.netId <= 0)
                continue;
            if (item.shape.type === 'segment') {
                const a = addNode(new Vec2(item.shape.x1, item.shape.y1), item.layer, item.netId, item.id);
                const b = addNode(new Vec2(item.shape.x2, item.shape.y2), item.layer, item.netId, item.id);
                union(a, b);
                segments.push({ a, b, layer: item.layer, netId: item.netId, width: item.shape.width });
            }
            else if (item.shape.type === 'circle' && typeof item.element?.getStartMidEnd === 'function') {
                const { start, end } = item.element.getStartMidEnd();
                const width = typeof item.element.getWidth === 'function' ? item.element.getWidth() : 0.25;
                const a = addNode(new Vec2(start.x, start.y), item.layer, item.netId, item.id);
                const b = addNode(new Vec2(end.x, end.y), item.layer, item.netId, item.id);
                union(a, b);
                segments.push({ a, b, layer: item.layer, netId: item.netId, width });
            }
        }
    }
    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        const cell = gridCell(node.point.x, node.point.y);
        const key = bucketKey(node.netId, node.layer);
        for (let x = cell.x - 1; x <= cell.x + 1; x++) {
            for (let y = cell.y - 1; y <= cell.y + 1; y++) {
                for (const other of endpointGrid.get(gridKey(key, x, y)) ?? []) {
                    // Incremental insertion means every candidate in the grid was
                    // added before `index`, so there is no `other > index` here to
                    // dedup against (unlike buildCopperGraph's post-hoc sweep).
                    // The itemId guard avoids re-uniting a segment's own two ends.
                    if (nodes[other].itemId === node.itemId)
                        continue;
                    // Tracks on different layers never touch (no via here).
                    if (nodes[other].layer !== node.layer)
                        continue;
                    if (distance(node.point, nodes[other].point) <= CONNECT_EPSILON_MM) {
                        union(index, other);
                    }
                }
            }
        }
        pushGridEntry(endpointGrid, gridKey(key, cell.x, cell.y), index);
    }
    return { nodes, segments, find, adjacent: index => adjacency[index] ?? [] };
}
/** Does `shape` overlap a zone fill, using the fill's triangle index when
 *  possible (fast) and falling back to an exact polygon overlap otherwise. */
function shapeOverlapsZone(shape, index) {
    // A segment is routed to the fill's exact width-honoring segment test
    // (a track touching the pour boundary counts even when the centerline
    // doesn't cross it — the dominant real-world case on routed power nets).
    // Other shapes are represented as small polygons so the fill's edge-based
    // overlapsPolygon gives a faithful answer; a circle is a 16-gon, plenty
    // for the ~sub-mm via/pad radii versus the mm-scale index cell.
    if (shape.type === 'segment') {
        return index.segmentTouches(shape.x1, shape.y1, shape.x2, shape.y2, shape.width);
    }
    const pts = [];
    if (shape.type === 'circle') {
        const steps = 16;
        for (let i = 0; i < steps; i++) {
            const a = (i / steps) * Math.PI * 2;
            pts.push({ x: shape.cx + shape.r * Math.cos(a), y: shape.cy + shape.r * Math.sin(a) });
        }
    }
    else if (shape.type === 'rect') {
        pts.push({ x: shape.x, y: shape.y }, { x: shape.x + shape.w, y: shape.y }, { x: shape.x + shape.w, y: shape.y + shape.h }, { x: shape.x, y: shape.y + shape.h });
    }
    else {
        pts.push(...shape.points);
    }
    return index.overlapsPolygon(pts, true);
}
/** Net+layer bucket key — a Unicode NUL separator so no netId/layer-name
 *  combination can ever collide with another (a plain "-" or space could,
 *  in principle, for a pathological layer name). */
function bucketKey(netId, layer) {
    return String(netId) + '\u0000' + layer;
}
function gridCell(x, y) {
    return { x: Math.floor(x / CONNECT_GRID_CELL_MM), y: Math.floor(y / CONNECT_GRID_CELL_MM) };
}
/** Minimal bbox of a point ring (used only for the zone near-cull fallback). */
function bboxOfPointsSimple(points) {
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
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
function gridKey(bucket, x, y) {
    return `${bucket}\u0000${x}\u0000${y}`;
}
function pushGridEntry(grid, key, index) {
    const entries = grid.get(key);
    if (entries)
        entries.push(index);
    else
        grid.set(key, [index]);
}
function unionAll(indices, union) {
    for (let index = 1; index < indices.length; index++)
        union(indices[0], indices[index]);
}
function footprintNetTieGroups(footprint) {
    const element = footprint?.findFirstChildByName?.('net_tie_pad_groups');
    const rawGroups = Array.isArray(element?.groups) ? element.groups : (element?.attributes ?? []).map((attribute) => attribute.value);
    return rawGroups.map(group => String(group).split(',').map(number => number.trim()).filter(Boolean)).filter(group => group.length > 0);
}
/** The incremental graph normally contains only the nets touched by a drag.
 * A net tie is a declared cross-net bridge, so its partner nets must enter
 * that local graph as well or a pad routed through the tie looks isolated
 * until a slow whole-board refresh happens. */
function expandNetFilterForJumpers(scene, netFilter) {
    const expanded = new Set(netFilter);
    const padsByFootprint = new Map();
    for (const items of scene.layerBuckets.values())
        for (const item of items) {
            if (item.kind !== 'pad' || !item.netId || !item.layer.endsWith('.Cu'))
                continue;
            const footprint = item.element?.parent;
            const padNumber = String(item.element?.padNumber ?? '');
            if (!footprint || !padNumber)
                continue;
            const byNumber = padsByFootprint.get(footprint) ?? new Map();
            const netIds = byNumber.get(padNumber) ?? new Set();
            netIds.add(item.netId);
            byNumber.set(padNumber, netIds);
            padsByFootprint.set(footprint, byNumber);
        }
    let changed = true;
    while (changed) {
        changed = false;
        for (const [footprint, padsByNumber] of padsByFootprint) {
            const groups = [];
            if (footprint.getSimpleChildValue?.('duplicate_pad_numbers_are_jumpers') === true) {
                for (const netIds of padsByNumber.values())
                    groups.push(netIds);
            }
            for (const padGroup of footprintNetTieGroups(footprint)) {
                const netIds = new Set();
                for (const padNumber of padGroup)
                    for (const netId of padsByNumber.get(padNumber) ?? [])
                        netIds.add(netId);
                groups.push(netIds);
            }
            for (const netIds of groups) {
                if (![...netIds].some(netId => expanded.has(netId)))
                    continue;
                for (const netId of netIds)
                    if (!expanded.has(netId)) {
                        expanded.add(netId);
                        changed = true;
                    }
            }
        }
    }
    return expanded;
}
function centerOf(item) {
    return new Vec2(item.bbox.x + item.bbox.w / 2, item.bbox.y + item.bbox.h / 2);
}
/** `PCB_SHAPE` can be a filled copper area or only a stroked perimeter.
 * The renderer's hit shape intentionally preserves the latter as an
 * unfilled rect/circle/poly, but connectivity must test the material stroke
 * itself rather than incorrectly shorting through its hollow interior. */
function graphicCopperShapes(item) {
    const shape = item.shape;
    if (shape.type === 'segment')
        return [shape];
    if (shape.type === 'circle') {
        if (typeof item.element?.getArcCenterRadiusAngles === 'function') {
            const width = Number(item.element.getStroke?.().width ?? shape.strokeWidth ?? 0.1);
            const arc = sweptArcShape(item.element.getArcCenterRadiusAngles(), width);
            return arc ? [arc] : [];
        }
        if (shape.filled !== false)
            return [shape];
        return circularStrokeSegments(shape, shape.strokeWidth ?? 0.1);
    }
    if (shape.filled !== false)
        return [shape];
    const width = shape.strokeWidth ?? 0.1;
    const points = shape.type === 'rect'
        ? [
            { x: shape.x, y: shape.y }, { x: shape.x + shape.w, y: shape.y },
            { x: shape.x + shape.w, y: shape.y + shape.h }, { x: shape.x, y: shape.y + shape.h },
        ]
        : shape.points;
    const segments = [];
    for (let index = 1; index < points.length; index++) {
        segments.push({ type: 'segment', x1: points[index - 1].x, y1: points[index - 1].y, x2: points[index].x, y2: points[index].y, width });
    }
    if (shape.type === 'rect' || shape.closed) {
        const first = points[0], last = points[points.length - 1];
        segments.push({ type: 'segment', x1: last.x, y1: last.y, x2: first.x, y2: first.y, width });
    }
    return segments;
}
function circularStrokeSegments(circle, width) {
    const count = Math.max(16, Math.ceil((Math.PI * 2 * circle.r) / Math.max(width / 2, 0.1)));
    const result = [];
    for (let index = 0; index < count; index++) {
        const a = Math.PI * 2 * index / count, b = Math.PI * 2 * (index + 1) / count;
        result.push({
            type: 'segment',
            x1: circle.cx + circle.r * Math.cos(a), y1: circle.cy + circle.r * Math.sin(a),
            x2: circle.cx + circle.r * Math.cos(b), y2: circle.cy + circle.r * Math.sin(b), width,
        });
    }
    return result;
}
export function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}
function sweptArcShape(arc, width) {
    const outer = arc.radius + width / 2;
    const inner = Math.max(0, arc.radius - width / 2);
    if (!(outer > 0) || !Number.isFinite(arc.startAngle) || !Number.isFinite(arc.endAngle))
        return null;
    const sweep = arc.endAngle - arc.startAngle;
    const steps = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 12)));
    const points = [];
    for (let i = 0; i <= steps; i++) {
        const angle = arc.startAngle + sweep * i / steps;
        points.push({ x: arc.centerX + outer * Math.cos(angle), y: arc.centerY + outer * Math.sin(angle) });
    }
    for (let i = steps; i >= 0; i--) {
        const angle = arc.startAngle + sweep * i / steps;
        points.push({ x: arc.centerX + inner * Math.cos(angle), y: arc.centerY + inner * Math.sin(angle) });
    }
    return { type: 'polygon', points, closed: true };
}
