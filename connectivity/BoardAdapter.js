/*
 * This file is a bridge between project's scene model (PaintedItem, LayeredBoardScene)
 * and KiCad's CN_ITEM_PARENT interface used by the connectivity algorithm.
 *
 * Copyright (C) 2024 CERN
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version 2
 * of the License, or (at your option) any later version.
 */
import { Vec2 } from "../math/Vec2";
import { BBox } from "../math/BBox";
import { KICAD_T, LSET, PCB_LAYER_ID, PAD_ATTRIB, } from "./ConnectivityItems";
/**
 * Maps a copper layer name to the compressed layer numbering the ported
 * connectivity code uses (ConnectivityItems.ts): F.Cu=0, B.Cu=2, everything
 * else = 1 (internal layers are not individually distinguishable by LSET,
 * see layerMaskOf below).
 */
export function layerIndexOf(layer) {
    if (layer === "F.Cu") {
        return PCB_LAYER_ID.F_Cu;
    }
    if (layer === "B.Cu") {
        return PCB_LAYER_ID.B_Cu;
    }
    // Vias span the whole stack; pads/tracks on internal layers all land in
    // the "other copper" bucket (1).
    return 1;
}
export function layerMaskOf(layer) {
    if (layer === "F.Cu") {
        return 1n << 0n;
    }
    if (layer === "B.Cu") {
        return 1n << 2n;
    }
    return 0n;
}
export class BoardAdapter {
    m_paintedItem;
    m_scene;
    constructor(item, scene) {
        this.m_paintedItem = item;
        this.m_scene = scene;
    }
    Type() {
        switch (this.m_paintedItem.kind) {
            case 'pad':
                return KICAD_T.PCB_PAD_T;
            case 'track':
                return KICAD_T.PCB_TRACE_T;
            case 'via':
                return KICAD_T.PCB_VIA_T;
            case 'zone':
                return KICAD_T.PCB_ZONE_T;
            case 'footprint':
            case 'footprint-ref':
                return KICAD_T.PCB_FOOTPRINT_T;
            default:
                return KICAD_T.PCB_SHAPE_T;
        }
    }
    GetNetCode() {
        return this.m_paintedItem.netId ?? -1;
    }
    GetNetname() {
        return this.m_paintedItem.netName ?? "";
    }
    GetBoundingBox() {
        return new BBox(this.m_paintedItem.bbox.x, this.m_paintedItem.bbox.y, this.m_paintedItem.bbox.w, this.m_paintedItem.bbox.h);
    }
    HitTest(aPoint, aAccuracy) {
        return hitTestShape(this.m_paintedItem.shape, aPoint, aAccuracy ?? 0.15);
    }
    IsOnCopperLayer() {
        switch (this.m_paintedItem.kind) {
            case 'pad':
            case 'track':
            case 'via':
            case 'zone':
                return true;
            case 'graphic':
                return this.m_paintedItem.layer.endsWith('.Cu');
            default:
                return false;
        }
    }
    IsConnected() {
        const net = this.GetNetCode();
        return net !== null && net !== undefined && net > 0;
    }
    GetLayerSet() {
        // Vias span the whole copper stack; everything else gets the mask of
        // its single layer. Internal layers are not representable in the
        // ported LSET (only F.Cu=0 / B.Cu=2) — see layerMaskOf.
        if (this.m_paintedItem.kind === 'via') {
            return new LSET().AllCuMask();
        }
        return new LSET(layerMaskOf(this.m_paintedItem.layer));
    }
    /** Returns a CN_SHAPE wrapper over the painted shape for the connectivity
     * collision tests (the ported equivalent of KiCad's GetEffectiveShape). */
    GetEffectiveShape(_layer, _flashing) {
        return new PaintedShapeAdapter(this.m_paintedItem.shape);
    }
    GetLayer() {
        return layerIndexOf(this.m_paintedItem.layer);
    }
    GetWidth() {
        const shape = this.m_paintedItem.shape;
        if (shape.type === 'segment') {
            return shape.width;
        }
        return 0;
    }
    GetStart() {
        const shape = this.m_paintedItem.shape;
        if (shape.type === 'segment') {
            return new Vec2(shape.x1, shape.y1);
        }
        if (shape.type === 'circle') {
            return new Vec2(shape.cx, shape.cy);
        }
        return new Vec2(this.m_paintedItem.bbox.x + this.m_paintedItem.bbox.w / 2, this.m_paintedItem.bbox.y + this.m_paintedItem.bbox.h / 2);
    }
    GetEnd() {
        const shape = this.m_paintedItem.shape;
        if (shape.type === 'segment') {
            return new Vec2(shape.x2, shape.y2);
        }
        return this.GetStart();
    }
    GetPosition() {
        return this.GetStart();
    }
    GetIsFree() {
        const net = this.GetNetCode();
        return net === 0 || net < 0;
    }
    GetAttribute() {
        // Scene pads are per-layer items without an attribute; SMD is the
        // common case and produces a single-layer CN_ITEM, which is the
        // correct behavior for the per-layer pad items we build from.
        return PAD_ATTRIB.SMD;
    }
    GetConnectionPoints() {
        const shape = this.m_paintedItem.shape;
        switch (shape.type) {
            case 'segment':
                return [new Vec2(shape.x1, shape.y1), new Vec2(shape.x2, shape.y2)];
            case 'circle':
                return [new Vec2(shape.cx, shape.cy)];
            case 'polygon':
                return shape.points.map(p => new Vec2(p.x, p.y));
            case 'rect':
                return [
                    new Vec2(shape.x, shape.y),
                    new Vec2(shape.x + shape.w, shape.y),
                    new Vec2(shape.x + shape.w, shape.y + shape.h),
                    new Vec2(shape.x, shape.y + shape.h),
                ];
        }
        return [];
    }
    ForEachUniqueLayer(fn) {
        fn(this.GetLayer());
    }
    Padstack() {
        return { ForEachUniqueLayer: (fn) => fn(this.GetLayer()) };
    }
    ShapePos(layer) {
        return this.GetPosition();
    }
    /** Vias are treated as through-hole (span the whole copper stack) for
     * now — the scene doesn't retain blind/buried via end layers. */
    TopLayer() {
        return PCB_LAYER_ID.F_Cu;
    }
    BottomLayer() {
        return PCB_LAYER_ID.B_Cu;
    }
    IsTeardropArea() {
        return false;
    }
    GetFilledPolysList(layer) {
        if (this.m_paintedItem.kind !== 'zone') {
            return null;
        }
        const zone = this.m_scene.zoneFills.find(z => z.layer === this.m_paintedItem.layer);
        if (!zone) {
            return null;
        }
        const outlines = zone.points;
        return {
            IsEmpty: () => !outlines || outlines.length === 0,
            OutlineCount: () => (outlines ? 1 : 0),
            Outline: (index) => ({ CPoints: () => outlines.map(p => new Vec2(p.x, p.y)) }),
            COutline: (index) => ({ CPoints: () => outlines.map(p => new Vec2(p.x, p.y)) }),
            TriangulatedPolyCount: () => 0,
            TriangulatedPolygon: (_i) => ({ GetSourceOutlineIndex: () => 0, Triangles: () => [] }),
        };
    }
    HitTestFilledArea(layer, point, accuracy) {
        const zone = this.m_scene.zoneFills.find(z => z.layer === this.m_paintedItem.layer);
        if (!zone) {
            return false;
        }
        return pointInPolygon(point, zone.points, accuracy);
    }
    GetDuplicatePadNumbersAreJumpers() {
        return false;
    }
    /**
     * Mirrors PAD::IsFreePad(): a pad whose parent is not a footprint. Scene
     * pad items are per-layer items with no footprint parent, so they count
     * as free pads (excluded from CN_CLUSTER's origin-pad ranking).
     */
    IsFreePad() {
        return this.m_paintedItem.kind !== 'pad' || this.GetParentFootprint() === null;
    }
    GetParentFootprint() {
        return this.m_paintedItem.kind === 'pad' ? null : this.m_paintedItem;
    }
    GetNumber() {
        const element = this.m_paintedItem.element;
        return element?.Reference?.Value ?? "";
    }
}
/**
 * Wraps a painted shape so the connectivity visitor's collision tests
 * (GetEffectiveShape → Collide) work against the same geometry the renderer
 * draws. Conservative but sufficient for pad/via/track connectivity: bbox
 * broad phase, endpoint containment, segment-segment distance and
 * segment-circle distance (long tracks passing through a via).
 */
export class PaintedShapeAdapter {
    m_shape;
    constructor(m_shape) {
        this.m_shape = m_shape;
    }
    BBox() {
        return bboxOfShape(this.m_shape);
    }
    Collide(other, accuracy = 0) {
        if (other instanceof Vec2) {
            return hitTestShape(this.m_shape, other, accuracy);
        }
        const o = other;
        const a = this.m_shape;
        const b = o.m_shape;
        if (!bboxIntersects(bboxOfShape(a), bboxOfShape(b), accuracy)) {
            return false;
        }
        if (a.type === 'segment' && b.type === 'segment') {
            return segmentSegmentDistance(a, b) <= (a.width + b.width) / 2 + accuracy;
        }
        if (a.type === 'circle' && b.type === 'segment') {
            return (pointToSegmentDistance(new Vec2(a.cx, a.cy), b) <= a.r + b.width / 2 + accuracy);
        }
        if (a.type === 'segment' && b.type === 'circle') {
            return (pointToSegmentDistance(new Vec2(b.cx, b.cy), a) <= b.r + a.width / 2 + accuracy);
        }
        // Endpoint containment both ways (a track landing on a pad, a via
        // inside a pad, etc.)
        for (const v of shapeVertices(a)) {
            if (hitTestShape(b, v, accuracy)) {
                return true;
            }
        }
        for (const v of shapeVertices(b)) {
            if (hitTestShape(a, v, accuracy)) {
                return true;
            }
        }
        return false;
    }
}
function hitTestShape(shape, aPoint, tolerance) {
    switch (shape.type) {
        case 'rect': {
            const dx = Math.abs((shape.x + shape.w / 2) - aPoint.x);
            const dy = Math.abs((shape.y + shape.h / 2) - aPoint.y);
            return dx <= tolerance + shape.w / 2 && dy <= tolerance + shape.h / 2;
        }
        case 'circle': {
            const dist = new Vec2(shape.cx, shape.cy).sub(aPoint).magnitude;
            return dist <= tolerance + shape.r;
        }
        case 'segment': {
            const dist = pointToSegmentDistance(aPoint, shape);
            return dist <= tolerance + shape.width / 2;
        }
        case 'polygon':
            return pointInPolygon(aPoint, shape.points, tolerance);
    }
    return false;
}
function bboxOfShape(shape) {
    switch (shape.type) {
        case 'rect':
            return new BBox(shape.x, shape.y, shape.w, shape.h);
        case 'circle':
            return new BBox(shape.cx - shape.r, shape.cy - shape.r, shape.r * 2, shape.r * 2);
        case 'segment':
            return BBox.fromPoints([new Vec2(shape.x1, shape.y1), new Vec2(shape.x2, shape.y2)]);
        case 'polygon':
            return BBox.fromPoints(shape.points.map(p => new Vec2(p.x, p.y)));
    }
}
function shapeVertices(shape) {
    switch (shape.type) {
        case 'rect':
            return [
                new Vec2(shape.x, shape.y),
                new Vec2(shape.x + shape.w, shape.y),
                new Vec2(shape.x + shape.w, shape.y + shape.h),
                new Vec2(shape.x, shape.y + shape.h),
            ];
        case 'circle':
            return [new Vec2(shape.cx, shape.cy)];
        case 'segment':
            return [new Vec2(shape.x1, shape.y1), new Vec2(shape.x2, shape.y2)];
        case 'polygon':
            return shape.points.map(p => new Vec2(p.x, p.y));
    }
}
function bboxIntersects(a, b, accuracy = 0) {
    return (a.x <= b.x2 + accuracy &&
        b.x <= a.x2 + accuracy &&
        a.y <= b.y2 + accuracy &&
        b.y <= a.y2 + accuracy);
}
function pointToSegmentDistance(point, shape) {
    const x1 = shape.x1, y1 = shape.y1, x2 = shape.x2, y2 = shape.y2;
    const dx = x2 - x1;
    const dy = y2 - y1;
    if (dx === 0 && dy === 0) {
        return new Vec2(x1, y1).sub(point).magnitude;
    }
    const t = Math.max(0, Math.min(1, ((point.x - x1) * dx + (point.y - y1) * dy) / (dx * dx + dy * dy)));
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    return point.sub(new Vec2(projX, projY)).magnitude;
}
function segmentSegmentDistance(s1, s2) {
    const p1 = new Vec2(s1.x1, s1.y1);
    const p2 = new Vec2(s1.x2, s1.y2);
    const p3 = new Vec2(s2.x1, s2.y1);
    const p4 = new Vec2(s2.x2, s2.y2);
    const d1 = p2.sub(p1);
    const d2 = p4.sub(p3);
    const denom = d1.x * d2.y - d1.y * d2.x;
    const diff = p3.sub(p1);
    if (Math.abs(denom) < 1e-12) {
        // Parallel — min endpoint distance.
        return Math.min(pointToSegmentDistance(p1, s2), pointToSegmentDistance(p2, s2), pointToSegmentDistance(p3, s1), pointToSegmentDistance(p4, s1));
    }
    const t = (diff.x * d2.y - diff.y * d2.x) / denom;
    const u = (diff.x * d1.y - diff.y * d1.x) / denom;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
        return 0;
    }
    return Math.min(pointToSegmentDistance(p1, s2), pointToSegmentDistance(p2, s2), pointToSegmentDistance(p3, s1), pointToSegmentDistance(p4, s1));
}
function pointInPolygon(point, points, tolerance) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const pi = points[i];
        const pj = points[j];
        const intersect = (pi.y > point.y !== pj.y > point.y) &&
            (point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x);
        if (intersect) {
            inside = !inside;
        }
    }
    return inside;
}
