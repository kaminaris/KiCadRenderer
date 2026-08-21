/*
 * Bridges the parsed board AST (@kicad-io KicadElement* objects) to the
 * connectivity engine's BOARD_ITEM / CN_ITEM_PARENT interface.
 *
 * Unlike BoardAdapter.ts (which wraps the flattened paint scene), this
 * facade is built straight from the board AST, so the connectivity code sees
 * the same item structure KiCad does:
 *   - pads grouped under their footprint (IsFreePad / origin-pad ranking /
 *     jumper pads work)
 *   - track arcs as PCB_ARC_T with their real start/end anchors
 *   - vias with their actual layer span from (layers ...)
 *   - a populated net code -> netname map
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later, same as the rest of this folder.
 */
import { Vec2 } from '../math/Vec2';
import { BBox } from '../math/BBox';
import { KICAD_T, LSET, PCB_LAYER_ID, PAD_ATTRIB, } from './ConnectivityItems';
import { layerIndexOf, layerMaskOf, PaintedShapeAdapter } from './BoardAdapter';
function elementKind(el) {
    switch (el?.name) {
        case 'footprint':
            return 'footprint';
        case 'pad':
            return 'pad';
        case 'segment':
            return 'track';
        case 'via':
            return 'via';
        case 'zone':
            return 'zone';
        case 'arc':
            // Both drawing arcs (KicadElementArc) and track arcs
            // (KicadElementTrackArc) are named 'arc'; track arcs carry a net.
            return typeof el.getNetId === 'function' ? 'arc' : null;
        default:
            return null;
    }
}
/** Effective copper layers of an element (expanding wildcards). */
function copperLayersOf(el, scene) {
    const all = scene.copperLayerStack;
    if (typeof el.getLayers === 'function') {
        const layers = el.getLayers(all);
        return layers.filter(l => l.endsWith('.Cu'));
    }
    return [];
}
/**
 * Wraps a single @kicad-io board element, presenting the BOARD_ITEM /
 * CN_ITEM_PARENT surface the connectivity port consumes. `aFootprint` is set
 * for pads (their owning footprint adapter).
 */
export class AstAdapter {
    m_el;
    m_kind;
    m_scene;
    m_footprint = null;
    constructor(el, kind, scene, footprint = null) {
        this.m_el = el;
        this.m_kind = kind;
        this.m_scene = scene;
        this.m_footprint = footprint;
    }
    Type() {
        switch (this.m_kind) {
            case 'footprint':
                return KICAD_T.PCB_FOOTPRINT_T;
            case 'pad':
                return KICAD_T.PCB_PAD_T;
            case 'track':
                return KICAD_T.PCB_TRACE_T;
            case 'arc':
                return KICAD_T.PCB_ARC_T;
            case 'via':
                return KICAD_T.PCB_VIA_T;
            case 'zone':
                return KICAD_T.PCB_ZONE_T;
        }
    }
    GetNetCode() {
        return this.m_el.getNetId?.() ?? -1;
    }
    GetNetname() {
        return this.m_el.getNetName?.() ?? '';
    }
    GetBoundingBox() {
        return bboxOfShape(this.shapeOf());
    }
    HitTest(aPoint, aAccuracy) {
        return hitTestShape(this.shapeOf(), aPoint, aAccuracy ?? 0.15);
    }
    IsOnCopperLayer() {
        if (this.m_kind === 'zone') {
            return this.copperLayers().length > 0;
        }
        return this.copperLayers().length > 0;
    }
    IsConnected() {
        return this.GetNetCode() > 0;
    }
    GetLayerSet() {
        if (this.m_kind === 'via') {
            return new LSET().AllCuMask();
        }
        let mask = 0n;
        for (const layer of this.copperLayers()) {
            mask |= layerMaskOf(layer);
        }
        return new LSET(mask);
    }
    GetEffectiveShape(_layer, _flashing) {
        return new PaintedShapeAdapter(this.shapeOf());
    }
    GetLayer() {
        const layers = this.copperLayers();
        return layers.length > 0 ? layerIndexOf(layers[0]) : 1;
    }
    GetWidth() {
        return this.m_el.getWidth?.() ?? 0;
    }
    GetStart() {
        if (typeof this.m_el.getStartMidEnd === 'function') {
            const { start } = this.m_el.getStartMidEnd();
            return new Vec2(start.x, start.y);
        }
        if (typeof this.m_el.getStartEnd === 'function') {
            const { start } = this.m_el.getStartEnd();
            return new Vec2(start.x, start.y);
        }
        return this.GetPosition();
    }
    GetEnd() {
        if (typeof this.m_el.getStartMidEnd === 'function') {
            const { end } = this.m_el.getStartMidEnd();
            return new Vec2(end.x, end.y);
        }
        if (typeof this.m_el.getStartEnd === 'function') {
            const { end } = this.m_el.getStartEnd();
            return new Vec2(end.x, end.y);
        }
        return this.GetPosition();
    }
    GetPosition() {
        const origin = this.m_el.getOrigin?.() ?? { x: 0, y: 0 };
        return new Vec2(origin.x, origin.y);
    }
    GetIsFree() {
        return this.GetNetCode() <= 0;
    }
    GetAttribute() {
        if (this.m_kind !== 'pad') {
            return PAD_ATTRIB.SMD;
        }
        switch (this.m_el.padType) {
            case 'thru_hole':
                return PAD_ATTRIB.PTH;
            case 'np_thru_hole':
                return PAD_ATTRIB.NPTH;
            case 'smd':
            default:
                return PAD_ATTRIB.SMD;
        }
    }
    GetConnectionPoints() {
        if (this.m_kind === 'pad' || this.m_kind === 'via') {
            return [this.GetPosition()];
        }
        return [this.GetStart(), this.GetEnd()];
    }
    ForEachUniqueLayer(fn) {
        fn(this.GetLayer());
    }
    Padstack() {
        return { ForEachUniqueLayer: (fn) => fn(this.GetLayer()) };
    }
    ShapePos(_layer) {
        return this.GetPosition();
    }
    TopLayer() {
        const layers = this.copperLayers();
        return layers.length > 0 ? layerIndexOf(layers[0]) : PCB_LAYER_ID.F_Cu;
    }
    BottomLayer() {
        const layers = this.copperLayers();
        return layers.length > 1
            ? layerIndexOf(layers[layers.length - 1])
            : PCB_LAYER_ID.B_Cu;
    }
    IsTeardropArea() {
        return false;
    }
    GetFilledPolysList(layer) {
        if (this.m_kind !== 'zone') {
            return null;
        }
        const zoneLayer = this.copperLayerName(layer);
        const zone = this.m_scene.zoneFills.find(z => z.layer === zoneLayer && z.netId === this.GetNetCode());
        if (!zone) {
            return null;
        }
        const outlines = zone.points;
        return {
            IsEmpty: () => !outlines || outlines.length === 0,
            OutlineCount: () => (outlines ? 1 : 0),
            Outline: (_index) => ({ CPoints: () => outlines.map(p => new Vec2(p.x, p.y)) }),
            COutline: (_index) => ({ CPoints: () => outlines.map(p => new Vec2(p.x, p.y)) }),
            TriangulatedPolyCount: () => 0,
            TriangulatedPolygon: (_i) => ({ GetSourceOutlineIndex: () => 0, Triangles: () => [] }),
        };
    }
    HitTestFilledArea(layer, point, accuracy) {
        const zoneLayer = this.copperLayerName(layer);
        const zone = this.m_scene.zoneFills.find(z => z.layer === zoneLayer && z.netId === this.GetNetCode());
        if (!zone) {
            return false;
        }
        return pointInPolygon(point, zone.points, accuracy);
    }
    /** The owning footprint adapter (pads only). */
    GetParentFootprint() {
        return this.m_kind === 'pad' ? this.m_footprint : null;
    }
    IsFreePad() {
        // Mirrors PAD::IsFreePad(): a pad whose parent is not a footprint.
        return this.m_kind !== 'pad' || this.m_footprint === null;
    }
    GetNumber() {
        return this.m_el.padNumber ?? '';
    }
    GetDuplicatePadNumbersAreJumpers() {
        return this.m_footprint?.m_el?.duplicate_pin_numbers_are_jumpers ?? false;
    }
    JumperPadGroups() {
        return this.m_footprint?.m_el?.jumper_pad_groups ?? [];
    }
    GetBoard() {
        return null;
    }
    /** The wrapped AST element (for Update/Remove identity). */
    Element() {
        return this.m_el;
    }
    Kind() {
        return this.m_kind;
    }
    /** Footprints only: the pads owned by this footprint. */
    Pads() {
        const pads = [];
        for (const padEl of this.m_el.children ?? []) {
            if (padEl?.name === 'pad') {
                pads.push(new AstAdapter(padEl, 'pad', this.m_scene, this));
            }
        }
        return pads;
    }
    copperLayers() {
        return copperLayersOf(this.m_el, this.m_scene);
    }
    copperLayerName(layer) {
        if (layer === PCB_LAYER_ID.F_Cu) {
            return 'F.Cu';
        }
        if (layer === PCB_LAYER_ID.B_Cu) {
            return 'B.Cu';
        }
        const stack = this.m_scene.copperLayerStack;
        return stack[layer] ?? stack[0] ?? 'F.Cu';
    }
    shapeOf() {
        const el = this.m_el;
        switch (this.m_kind) {
            case 'pad': {
                const origin = el.getOrigin?.() ?? { x: 0, y: 0 };
                const size = el.getSize?.() ?? { width: 0, height: 0 };
                return { type: 'rect', x: origin.x - size.width / 2, y: origin.y - size.height / 2, w: size.width, h: size.height };
            }
            case 'via': {
                const origin = el.getOrigin?.() ?? { x: 0, y: 0 };
                const size = el.getSize?.() ?? { width: 0, height: 0 };
                return { type: 'circle', cx: origin.x, cy: origin.y, r: size.width / 2 };
            }
            case 'track':
            case 'arc': {
                const width = el.getWidth?.() ?? 0.25;
                return { type: 'segment', x1: this.GetStart().x, y1: this.GetStart().y, x2: this.GetEnd().x, y2: this.GetEnd().y, width };
            }
            case 'zone':
            default: {
                const bbox = this.m_scene.zoneFills.find(z => z.netId === this.GetNetCode());
                if (bbox) {
                    return { type: 'polygon', points: bbox.points };
                }
                return { type: 'rect', x: 0, y: 0, w: 0, h: 0 };
            }
        }
    }
}
/**
 * Builds the board facade from the parsed board AST. `rootElement` is the
 * `(kicad_pcb ...)` root (the session's boardRoot.rootElement).
 */
export function buildBoardFacadeFromAst(rootElement, scene) {
    const footprints = [];
    const tracks = [];
    const vias = [];
    const zones = [];
    const netInfo = [];
    for (const child of rootElement.children ?? []) {
        switch (child?.name) {
            case 'net': {
                const id = child.id ?? 0;
                const name = child.netName ?? '';
                netInfo.push({
                    GetNetCode: () => id,
                    GetNetname: () => name,
                });
                break;
            }
            case 'footprint': {
                footprints.push(new AstAdapter(child, 'footprint', scene));
                break;
            }
            case 'segment': {
                tracks.push(new AstAdapter(child, 'track', scene));
                break;
            }
            case 'arc': {
                // Track arcs carry a net; drawing arcs don't.
                if (typeof child.getNetId === 'function') {
                    tracks.push(new AstAdapter(child, 'arc', scene));
                }
                break;
            }
            case 'via': {
                vias.push(new AstAdapter(child, 'via', scene));
                break;
            }
            case 'zone': {
                zones.push(new AstAdapter(child, 'zone', scene));
                break;
            }
        }
    }
    // Pads are reachable via footprint.Pads() (the algo's Build() adds pads
    // from footprint.Pads()); tracks/arcs/vias are top-level board items.
    const allTracks = [...tracks, ...vias];
    return {
        Zones: () => zones,
        Tracks: () => allTracks,
        Footprints: () => footprints,
        Drawings: () => [],
        GetEnabledLayers: () => new LSET().AllCuMask(),
        GetNetInfo: () => netInfo,
    };
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
            const x1 = shape.x1, y1 = shape.y1, x2 = shape.x2, y2 = shape.y2;
            const dx = x2 - x1, dy = y2 - y1;
            const t = Math.max(0, Math.min(1, ((aPoint.x - x1) * dx + (aPoint.y - y1) * dy) / (dx * dx + dy * dy)));
            const projX = x1 + t * dx, projY = y1 + t * dy;
            const dist = aPoint.sub(new Vec2(projX, projY)).magnitude;
            return dist <= tolerance + shape.width / 2;
        }
        case 'polygon':
            return pointInPolygon(aPoint, shape.points, tolerance);
    }
    return false;
}
function pointInPolygon(point, points, _tolerance) {
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
