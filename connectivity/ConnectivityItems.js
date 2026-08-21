/*
 * This file is ported from KiCad source files:
 *   pcbnew/connectivity/connectivity_items.h
 *   pcbnew/connectivity/connectivity_items.cpp
 *
 * Copyright (C) 2013-2018 CERN
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version 2
 * of the License, or (at your option) any later version.
 */
import { Vec2 } from '../math/Vec2';
import { BBox } from '../math/BBox';
import { DYNAMIC_RTREE } from './DynamicRtree';
export const INT_MAX = Number.MAX_SAFE_INTEGER;
export class LSET {
    m_mask = 0n;
    constructor(masks) {
        if (masks !== undefined) {
            this.m_mask = masks;
        }
    }
    AllCuMask() {
        return new LSET((1n << 0n) | (1n << 2n));
    }
    operatorAnd(other) {
        return new LSET(this.m_mask & other.m_mask);
    }
    and(other) {
        return this.operatorAnd(other);
    }
    HasLayers() {
        return this.m_mask !== 0n;
    }
    RunOnLayers(fn) {
        if (this.m_mask & 1n)
            fn(0);
        if (this.m_mask & 1n << 2n)
            fn(2);
    }
    ToBigInt() {
        return this.m_mask;
    }
    Clone() {
        return new LSET(this.m_mask);
    }
    /**
     * Copper layers contained in this set, in KiCad's CuStack() order
     * (internal layers first, then B.Cu, then F.Cu). The ported LSET only
     * tracks F.Cu (bit 0) and B.Cu (bit 2).
     */
    CuStack() {
        const seq = [];
        if (this.m_mask & (1n << 2n)) {
            seq.push(PCB_LAYER_ID.B_Cu);
        }
        if (this.m_mask & (1n << 0n)) {
            seq.push(PCB_LAYER_ID.F_Cu);
        }
        return seq;
    }
}
export const KICAD_T = {
    NOT_USED: -1,
    TYPE_NOT_INIT: 0,
    PCB_T: 1,
    PCB_FOOTPRINT_T: 3,
    PCB_PAD_T: 4,
    PCB_SHAPE_T: 5,
    PCB_TRACE_T: 10,
    PCB_VIA_T: 11,
    PCB_ARC_T: 12,
    PCB_ZONE_T: 22,
};
export const PAD_ATTRIB = {
    PTH: 0,
    SMD: 1,
    CONN: 2,
    NPTH: 3,
};
export const PCB_LAYER_ID = {
    F_Cu: 0,
    B_Cu: 2,
};
/**
 * Minimal triangle shape used by CN_ZONE_LAYER's R-tree. In KiCad this is
 * SHAPE_POLY_SET::TRIANGULATED_POLYGON::TRI.
 */
export class CN_TRI {
    a;
    b;
    c;
    constructor(a, b, c) {
        this.a = a;
        this.b = b;
        this.c = c;
    }
    BBox() {
        return BBox.fromPoints([this.a, this.b, this.c]);
    }
    Collide(other, _accuracy) {
        if (other instanceof Vec2) {
            return this.pointInTriangle(other);
        }
        // Broad-phase bbox intersection for shape-vs-triangle. A downstream
        // adapter may override CN_ZONE_LAYER.Collide for a more exact test.
        return (this.BBox().containsPoint(other.BBox().start) ||
            this.BBox().containsPoint(other.BBox().end) ||
            other.BBox().containsPoint(this.BBox().start) ||
            other.BBox().containsPoint(this.BBox().end));
    }
    pointInTriangle(p) {
        const as_x = p.x - this.a.x;
        const as_y = p.y - this.a.y;
        const s_ab = (this.b.x - this.a.x) * as_y - (this.b.y - this.a.y) * as_x > 0;
        if ((this.c.x - this.a.x) * as_y - (this.c.y - this.a.y) * as_x > 0 === s_ab) {
            return false;
        }
        if ((this.c.x - this.b.x) * (p.y - this.b.y) -
            (this.c.y - this.b.y) * (p.x - this.b.x) >
            0 !==
            s_ab) {
            return false;
        }
        return true;
    }
}
/**
 * CN_RTREE - Implements an R-tree for fast spatial indexing of connectivity
 * items. Non-owning. Ported from pcbnew/connectivity/connectivity_rtree.h,
 * which wraps KIRTREE::DYNAMIC_RTREE (kimath/geometry/rtree/dynamic_rtree.h).
 */
class CN_RTREE {
    m_tree = new DYNAMIC_RTREE();
    /**
     * Function Insert()
     * Inserts an item into the tree. Item's bounding box is taken via its BBox() method.
     */
    Insert(min, max, item) {
        this.m_tree.Insert(min, max, item);
    }
    /**
     * Function Remove()
     * Removes an item from the tree. Removal is done by comparing data references,
     * attempting to remove a copy of the item will fail.
     */
    Remove(min, max, item) {
        this.m_tree.Remove(min, max, item);
    }
    /**
     * Function RemoveAll()
     * Removes all items from the RTree
     */
    RemoveAll() {
        this.m_tree.RemoveAll();
    }
    /**
     * Function Query()
     * Executes a function object aVisitor for each item whose bounding box
     * intersects with aBounds (on the layer range [aStartLayer, aEndLayer]).
     */
    Query(bbox, startLayer, endLayer, visitor) {
        const start_layer = startLayer === PCB_LAYER_ID.B_Cu ? INT_MAX : startLayer;
        const end_layer = endLayer === PCB_LAYER_ID.B_Cu ? INT_MAX : endLayer;
        const min = [start_layer, bbox.x, bbox.y];
        const max = [end_layer, bbox.x2, bbox.y2];
        this.m_tree.Search(min, max, visitor);
    }
}
/**
 * CN_ANCHOR represents a physical location that can be connected: a pad or a
 * track/arc/via endpoint.
 */
export class CN_ANCHOR {
    // Tag used for unconnected items.
    static TAG_UNCONNECTED = -1;
    m_pos;
    m_item;
    m_tag;
    m_noline;
    m_cluster = null;
    constructor(aPos, aItem) {
        this.m_pos = aPos;
        this.m_item = aItem;
        this.m_tag = -1;
        this.m_noline = false;
    }
    Valid() {
        if (!this.m_item) {
            return false;
        }
        return this.m_item.Valid();
    }
    Dirty() {
        return !this.Valid() || this.m_item.Dirty();
    }
    Item() {
        return this.m_item;
    }
    SetItem(aItem) {
        this.m_item = aItem;
    }
    Parent() {
        if (!this.m_item || !this.m_item.Valid()) {
            throw new Error('CN_ANCHOR::Parent(): invalid item');
        }
        return this.m_item.Parent();
    }
    Pos() {
        return this.m_pos;
    }
    Move(aPos) {
        this.m_pos = this.m_pos.add(aPos);
    }
    Dist(aSecond) {
        return this.m_pos.sub(aSecond.Pos()).magnitude;
    }
    /**
     * @return tag, a common identifier for connected nodes.
     */
    GetTag() {
        return this.m_tag;
    }
    SetTag(aTag) {
        this.m_tag = aTag;
    }
    /**
     * @return true if this node can be a target for ratsnest lines.
     */
    GetNoLine() {
        return this.m_noline;
    }
    SetNoLine(aEnable) {
        this.m_noline = aEnable;
    }
    GetCluster() {
        return this.m_cluster;
    }
    SetCluster(aCluster) {
        this.m_cluster = aCluster;
    }
    /**
     * The anchor point is dangling if the parent is a track and this anchor point is not
     * connected to another item ( track, vias pad or zone) or if the parent is a via and
     * this anchor point is connected to only one track and not to another item.
     *
     * @return true if this anchor is dangling.
     */
    IsDangling() {
        let accuracy = 0;
        if (!this.m_cluster) {
            return true;
        }
        // the minimal number of items connected to item_ref
        // at this anchor point to decide the anchor is *not* dangling
        let minimal_count = 1;
        let connected_count = this.m_item.ConnectedItems().length;
        // a via can be removed if connected to only one other item.
        if (this.Parent().Type() === KICAD_T.PCB_VIA_T) {
            return connected_count < 2;
        }
        if (this.m_item.AnchorCount() === 1) {
            return connected_count < minimal_count;
        }
        const parent = this.Parent();
        if (parent.Type() === KICAD_T.PCB_TRACE_T || parent.Type() === KICAD_T.PCB_ARC_T) {
            accuracy = Math.round(parent.GetWidth() / 2.0);
        }
        else if (parent.Type() === KICAD_T.PCB_SHAPE_T) {
            accuracy = Math.round(parent.GetWidth() / 2.0);
        }
        // Items with multiple anchors have usually items connected to each anchor.
        // We want only the item count of this anchor point
        connected_count = 0;
        for (const item of this.m_item.ConnectedItems()) {
            const itemParent = item.Parent();
            if (itemParent.Type() === KICAD_T.PCB_ZONE_T) {
                const zone = itemParent;
                if (zone.HitTestFilledArea(item.GetBoardLayer(), this.Pos(), accuracy)) {
                    connected_count++;
                }
            }
            else if (itemParent.HitTest && itemParent.HitTest(this.Pos(), accuracy)) {
                connected_count++;
            }
        }
        return connected_count < minimal_count;
    }
    /**
     * @return the count of tracks and vias connected to this anchor.
     */
    ConnectedItemsCount() {
        if (!this.m_cluster) {
            return 0;
        }
        let connected_count = 0;
        for (const item of this.m_item.ConnectedItems()) {
            const itemParent = item.Parent();
            if (itemParent.Type() === KICAD_T.PCB_ZONE_T) {
                const zone = itemParent;
                if (zone.HitTestFilledArea(item.GetBoardLayer(), this.Pos())) {
                    connected_count++;
                }
            }
            else if (itemParent.HitTest && itemParent.HitTest(this.Pos())) {
                connected_count++;
            }
        }
        return connected_count;
    }
}
/**
 * CN_ITEM represents a BOARD_CONNECTED_ITEM in the connectivity system (ie:
 * a pad, track/arc/via, or zone).
 */
export class CN_ITEM {
    m_dirty;
    m_start_layer;
    m_end_layer;
    m_bbox;
    m_parent;
    m_connected = [];
    m_anchors = [];
    m_canChangeNet;
    m_valid;
    constructor(aParent, aCanChangeNet, aAnchorCount = 2) {
        this.m_parent = aParent;
        this.m_canChangeNet = aCanChangeNet;
        this.m_valid = true;
        this.m_dirty = true;
        this.m_start_layer = 0;
        this.m_end_layer = INT_MAX;
        this.m_bbox = new BBox();
    }
    Dump() {
        // eslint-disable-next-line no-console
        console.debug('CN_ITEM::Dump valid:', this.Valid(), 'connected:', this.m_connected.length);
        for (const i of this.m_connected) {
            const t = i.Parent();
            // eslint-disable-next-line no-console
            console.debug('  - connected item type:', t?.Type());
        }
    }
    AddAnchor(aPos) {
        const anchor = new CN_ANCHOR(aPos, this);
        this.m_anchors.push(anchor);
        return anchor;
    }
    Anchors() {
        return this.m_anchors;
    }
    SetValid(aValid) {
        this.m_valid = aValid;
    }
    Valid() {
        return this.m_valid;
    }
    SetDirty(aDirty) {
        this.m_dirty = aDirty;
    }
    Dirty() {
        return this.m_dirty;
    }
    /**
     * Set the layers spanned by the item to aStartLayer and aEndLayer.
     */
    SetLayers(aStartLayer, aEndLayer) {
        // B_Cu is nominally layer 2 but we reset it to INT_MAX to ensure that it is
        // always greater than any other layer in the RTree
        if (aStartLayer === PCB_LAYER_ID.B_Cu) {
            aStartLayer = INT_MAX;
        }
        if (aEndLayer === PCB_LAYER_ID.B_Cu) {
            aEndLayer = INT_MAX;
        }
        this.m_start_layer = aStartLayer;
        this.m_end_layer = aEndLayer;
    }
    /**
     * Set the layers spanned by the item to a single layer aLayer.
     */
    SetLayer(aLayer) {
        this.SetLayers(aLayer, aLayer);
    }
    /**
     * Return the contiguous set of layers spanned by the item.
     */
    StartLayer() {
        return this.m_start_layer;
    }
    EndLayer() {
        return this.m_end_layer;
    }
    /**
     * Return the item's layer, for single-layered items only.
     * N.B. This should only be used inside connectivity as B_Cu
     * is mapped to a large int
     */
    Layer() {
        return this.StartLayer();
    }
    /**
     * When using CN_ITEM layers to compare against board items,
     * use this function which correctly remaps the B_Cu layer
     */
    GetBoardLayer() {
        let layer = this.Layer();
        if (layer === INT_MAX) {
            layer = PCB_LAYER_ID.B_Cu;
        }
        return layer;
    }
    BBox() {
        if (this.m_dirty && this.m_valid) {
            this.m_bbox = this.m_parent?.GetBoundingBox() ?? new BBox();
            this.m_dirty = false;
        }
        return this.m_bbox;
    }
    Parent() {
        if (!this.m_parent) {
            throw new Error('CN_ITEM::Parent(): no parent');
        }
        return this.m_parent;
    }
    ConnectedItems() {
        return this.m_connected;
    }
    ClearConnections() {
        this.m_connected = [];
    }
    CanChangeNet() {
        return this.m_canChangeNet;
    }
    Connect(b) {
        if (this.m_connected.indexOf(b) < 0) {
            this.m_connected.push(b);
        }
    }
    RemoveInvalidRefs() {
        this.m_connected = this.m_connected.filter((item) => item.Valid());
    }
    AnchorCount() {
        if (!this.m_valid) {
            return 0;
        }
        const type = this.m_parent?.Type() ?? KICAD_T.NOT_USED;
        switch (type) {
            case KICAD_T.PCB_TRACE_T:
            case KICAD_T.PCB_ARC_T:
                return 2; // start and end
            case KICAD_T.PCB_SHAPE_T:
                return this.m_anchors.length;
            default:
                return 1;
        }
    }
    GetAnchor(n) {
        if (!this.m_valid) {
            return new Vec2();
        }
        const parent = this.m_parent;
        if (!parent) {
            return new Vec2();
        }
        switch (parent.Type()) {
            case KICAD_T.PCB_PAD_T:
                return parent.GetPosition();
            case KICAD_T.PCB_TRACE_T:
            case KICAD_T.PCB_ARC_T:
                if (n === 0) {
                    return parent.GetStart();
                }
                else {
                    return parent.GetEnd();
                }
            case KICAD_T.PCB_VIA_T:
                return parent.GetStart();
            case KICAD_T.PCB_SHAPE_T:
                return n < this.m_anchors.length ? this.m_anchors[n].Pos() : new Vec2();
            default:
                throw new Error(`CN_ITEM::GetAnchor(): unimplemented for type ${parent.Type()}`);
        }
    }
    Net() {
        if (!this.m_parent || !this.m_valid) {
            return -1;
        }
        return this.m_parent.GetNetCode();
    }
}
export class ITEM_MAP_ENTRY {
    m_items = [];
    constructor(aItem) {
        if (aItem) {
            this.m_items.push(aItem);
        }
    }
    MarkItemsAsInvalid() {
        for (const item of this.m_items) {
            item.SetValid(false);
        }
    }
    Link(aItem) {
        this.m_items.push(aItem);
    }
    GetItems() {
        return this.m_items;
    }
}
/**
 * Represents a single outline of a zone fill on a particular layer.
 * aSubpolyIndex indicates which outline in the fill's polygon set.
 */
export class CN_ZONE_LAYER extends CN_ITEM {
    m_zone;
    m_subpolyIndex;
    m_layer;
    m_outline = [];
    m_triangulatedPolys = [];
    // Ported from connectivity_items.h: CN_ZONE_LAYER uses a 2D
    // KIRTREE::DYNAMIC_RTREE<const SHAPE*, int, 2> directly (not CN_RTREE).
    m_rTree = new DYNAMIC_RTREE(2, 16);
    constructor(aParent, aLayer, aSubpolyIndex) {
        super(aParent, false);
        this.m_zone = aParent;
        this.m_subpolyIndex = aSubpolyIndex;
        this.m_layer = aLayer;
        const fillPoly = this.m_zone.GetFilledPolysList(aLayer);
        if (fillPoly && aSubpolyIndex < fillPoly.OutlineCount()) {
            this.m_outline = fillPoly.Outline(aSubpolyIndex).CPoints();
        }
        this.SetLayers(aLayer, aLayer);
    }
    BuildRTree() {
        if (this.m_zone.IsTeardropArea()) {
            return;
        }
        this.m_triangulatedPolys = [];
        this.m_rTree.RemoveAll();
        const fillPoly = this.m_zone.GetFilledPolysList(this.m_layer);
        if (!fillPoly) {
            return;
        }
        for (let ii = 0; ii < fillPoly.TriangulatedPolyCount(); ii++) {
            const triangleSet = fillPoly.TriangulatedPolygon(ii);
            if (triangleSet.GetSourceOutlineIndex() !== this.m_subpolyIndex) {
                continue;
            }
            // Deep copy the triangulated polygon. The copy constructor copies the vertex storage
            // and updates all TRI parent pointers to reference our owned copy. This ensures the
            // triangles remain valid even if the zone is refilled on another thread.
            const tris = [];
            for (const tri of triangleSet.Triangles()) {
                tris.push(new CN_TRI(tri.A, tri.B, tri.C));
            }
            this.m_triangulatedPolys.push(tris);
        }
        for (const triPoly of this.m_triangulatedPolys) {
            for (const tri of triPoly) {
                const bbox = tri.BBox();
                const mmin = [bbox.x, bbox.y];
                const mmax = [bbox.x2, bbox.y2];
                this.m_rTree.Insert(mmin, mmax, tri);
            }
        }
    }
    SubpolyIndex() {
        return this.m_subpolyIndex;
    }
    GetLayer() {
        return this.m_layer;
    }
    ContainsPoint(p) {
        if (this.m_outline.length === 0) {
            return false;
        }
        if (this.m_zone.IsTeardropArea()) {
            return this.outlineCollidePoint(p);
        }
        const mmin = [p.x, p.y];
        const mmax = [p.x, p.y];
        let collision = false;
        const visitor = (tri) => {
            if (tri.Collide(p)) {
                collision = true;
                return false;
            }
            return true;
        };
        this.m_rTree.Search(mmin, mmax, visitor);
        return collision;
    }
    AnchorCount() {
        if (!this.Valid() || !this.HasValidOutline()) {
            return 0;
        }
        return this.GetOutline().length > 0 ? 1 : 0;
    }
    GetAnchor(_n) {
        if (!this.Valid() || !this.HasValidOutline()) {
            return new Vec2();
        }
        return this.GetOutline()[0];
    }
    HasValidOutline() {
        return this.m_outline.length > 0;
    }
    GetOutline() {
        return this.m_outline;
    }
    OutlinePointCount() {
        return this.m_outline.length;
    }
    OutlinePoint(aIndex) {
        return this.m_outline[aIndex];
    }
    Collide(aRefShape) {
        if (this.m_outline.length === 0) {
            return false;
        }
        if (this.m_zone.IsTeardropArea()) {
            return this.outlineCollideShape(aRefShape);
        }
        const bbox = aRefShape.BBox();
        const mmin = [bbox.x, bbox.y];
        const mmax = [bbox.x2, bbox.y2];
        let collision = false;
        const visitor = (tri) => {
            if (aRefShape.Collide(tri)) {
                collision = true;
                return false;
            }
            return true;
        };
        this.m_rTree.Search(mmin, mmax, visitor);
        return collision;
    }
    HasSingleConnection() {
        let count = 0;
        for (const item of this.ConnectedItems()) {
            if (item.Valid()) {
                count++;
            }
            if (count > 1) {
                break;
            }
        }
        return count === 1;
    }
    outlineCollidePoint(p) {
        // Point-in-polygon test for teardrop / outline-only collision mode.
        let inside = false;
        for (let i = 0, j = this.m_outline.length - 1; i < this.m_outline.length; j = i++) {
            const pi = this.m_outline[i];
            const pj = this.m_outline[j];
            const intersect = pi.y > p.y !== pj.y > p.y &&
                p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x;
            if (intersect) {
                inside = !inside;
            }
        }
        return inside;
    }
    outlineCollideShape(shape) {
        // Conservative outline-vs-shape collision used for teardrop areas.
        const bbox = shape.BBox();
        if (!this.outlineBBox().containsPoint(bbox.start) && !this.outlineBBox().containsPoint(bbox.end)) {
            return false;
        }
        return this.outlineCollidePoint(bbox.center);
    }
    outlineBBox() {
        return BBox.fromPoints(this.m_outline);
    }
}
/**
 * A connected component; stores the items that form one electrically connected
 * cluster.
 */
export class CN_CLUSTER {
    m_conflicting;
    m_originNet;
    m_originPad;
    m_items = [];
    m_netRanks = new Map();
    constructor() {
        this.m_originPad = null;
        this.m_originNet = -1;
        this.m_conflicting = false;
    }
    HasValidNet() {
        return this.m_originNet > 0;
    }
    OriginNet() {
        return this.m_originNet;
    }
    OriginNetName() {
        if (!this.m_originPad || !this.m_originPad.Valid()) {
            return '<none>';
        }
        else {
            return this.m_originPad.Parent().GetNetname();
        }
    }
    Contains(aItem) {
        return this.m_items.indexOf(aItem) >= 0;
    }
    ContainsParent(aItem) {
        return (this.m_items.find((item) => item.Valid() && item.Parent() === aItem) !== undefined);
    }
    Dump() {
        for (const item of this.m_items) {
            const parent = item.Parent();
            // eslint-disable-next-line no-console
            console.debug(' - item :', item, 'bitem :', parent, 'type :', parent.Type(), 'inet :', parent.GetNetname());
            item.Dump();
        }
    }
    Size() {
        return this.m_items.length;
    }
    IsOrphaned() {
        return this.m_originPad === null;
    }
    IsConflicting() {
        return this.m_conflicting;
    }
    Add(item) {
        this.m_items.push(item);
        const netCode = item.Net();
        if (netCode <= 0) {
            return;
        }
        if (this.m_originNet <= 0) {
            this.m_originNet = netCode;
            this.m_netRanks.set(this.m_originNet, 0);
        }
        const itemParent = item.Parent();
        if (itemParent.Type() === KICAD_T.PCB_PAD_T && !itemParent.IsFreePad()) {
            let rank;
            const it = this.m_netRanks.get(netCode);
            if (it === undefined) {
                this.m_netRanks.set(netCode, 1);
                rank = 1;
            }
            else {
                this.m_netRanks.set(netCode, it + 1);
                rank = it + 1;
            }
            const originRank = this.m_netRanks.get(this.m_originNet) ?? 0;
            if (!this.m_originPad || rank > originRank) {
                this.m_originPad = item;
                this.m_originNet = netCode;
            }
            if (this.m_originPad && item.Net() !== this.m_originNet) {
                this.m_conflicting = true;
            }
        }
    }
    *[Symbol.iterator]() {
        for (const item of this.m_items) {
            yield item;
        }
    }
}
/**
 * A list/owner of CN_ITEM objects, backed by a spatial index for fast
 * nearest-neighbor queries.
 */
export class CN_LIST {
    m_items = [];
    m_dirty = false;
    m_hasInvalid = false;
    m_index = new CN_RTREE();
    constructor() {
        this.m_dirty = false;
        this.m_hasInvalid = false;
    }
    begin() {
        return this.m_items;
    }
    Clear() {
        for (const item of this.m_items) {
            // TypeScript has no deterministic destructor. The original C++ deletes the
            // item here; downstream code should drop references to let GC reclaim it.
            item.SetValid(false);
        }
        this.m_items = [];
        this.m_index.RemoveAll();
    }
    *[Symbol.iterator]() {
        for (const item of this.m_items) {
            yield item;
        }
    }
    operatorIndex(aIndex) {
        return this.m_items[aIndex];
    }
    FindNearby(aItem, aFunc) {
        this.m_index.Query(aItem.BBox(), aItem.StartLayer(), aItem.EndLayer(), aFunc);
    }
    SetHasInvalid(aInvalid = true) {
        this.m_hasInvalid = aInvalid;
    }
    SetDirty(aDirty = true) {
        this.m_dirty = aDirty;
    }
    IsDirty() {
        return this.m_dirty;
    }
    RemoveInvalidItems(aGarbage) {
        if (!this.m_hasInvalid) {
            return;
        }
        const remaining = [];
        for (const item of this.m_items) {
            if (item.Valid()) {
                remaining.push(item);
            }
            else {
                aGarbage.push(item);
            }
        }
        this.m_items = remaining;
        for (const item of aGarbage) {
            const bbox = item.BBox();
            const min = [item.StartLayer(), bbox.x, bbox.y];
            const max = [item.EndLayer(), bbox.x2, bbox.y2];
            this.m_index.Remove(min, max, item);
        }
        this.m_hasInvalid = false;
    }
    ClearDirtyFlags() {
        for (const item of this.m_items) {
            item.SetDirty(false);
        }
        this.SetDirty(false);
    }
    Size() {
        return this.m_items.length;
    }
    Add(pad) {
        if (!pad.IsOnCopperLayer()) {
            return null;
        }
        const item = new CN_ITEM(pad, false, 1);
        const uniqueAnchors = new Map();
        pad.Padstack().ForEachUniqueLayer((aLayer) => {
            const pos = pad.ShapePos(aLayer);
            uniqueAnchors.set(`${pos.x},${pos.y}`, pos);
        });
        for (const anchor of uniqueAnchors.values()) {
            item.AddAnchor(anchor);
        }
        item.SetLayers(PCB_LAYER_ID.F_Cu, PCB_LAYER_ID.B_Cu);
        switch (pad.GetAttribute()) {
            case PAD_ATTRIB.SMD:
            case PAD_ATTRIB.NPTH:
            case PAD_ATTRIB.CONN: {
                const lmsk = pad.GetLayerSet().CuStack();
                if (lmsk.length > 0) {
                    item.SetLayer(lmsk[0]);
                }
                break;
            }
            default:
                break;
        }
        this.addItemtoTree(item);
        this.m_items.push(item);
        // Re-mark dirty after tree insertion since BBox() clears the dirty flag
        item.SetDirty(true);
        this.SetDirty();
        return item;
    }
    AddTrack(track) {
        const item = new CN_ITEM(track, true);
        this.m_items.push(item);
        item.AddAnchor(track.GetStart());
        item.AddAnchor(track.GetEnd());
        item.SetLayer(track.GetLayer());
        this.addItemtoTree(item);
        // Re-mark dirty after tree insertion since BBox() clears the dirty flag
        item.SetDirty(true);
        this.SetDirty();
        return item;
    }
    AddArc(aArc) {
        const item = new CN_ITEM(aArc, true);
        this.m_items.push(item);
        item.AddAnchor(aArc.GetStart());
        item.AddAnchor(aArc.GetEnd());
        item.SetLayer(aArc.GetLayer());
        this.addItemtoTree(item);
        // Re-mark dirty after tree insertion since BBox() clears the dirty flag
        item.SetDirty(true);
        this.SetDirty();
        return item;
    }
    AddVia(via) {
        const item = new CN_ITEM(via, !via.GetIsFree(), 1);
        this.m_items.push(item);
        item.AddAnchor(via.GetStart());
        item.SetLayers(via.TopLayer(), via.BottomLayer());
        this.addItemtoTree(item);
        // Re-mark dirty after tree insertion since BBox() clears the dirty flag
        item.SetDirty(true);
        this.SetDirty();
        return item;
    }
    AddZone(zone, aLayer) {
        const polys = zone.GetFilledPolysList(aLayer);
        const rv = [];
        if (!polys) {
            return rv;
        }
        for (let j = 0; j < polys.OutlineCount(); j++) {
            const zitem = new CN_ZONE_LAYER(zone, aLayer, j);
            zitem.BuildRTree();
            const outline = zone.GetFilledPolysList(aLayer).COutline(j);
            for (const pt of outline.CPoints()) {
                zitem.AddAnchor(pt);
            }
            rv.push(this.AddZoneLayer(zitem));
        }
        return rv;
    }
    AddZoneLayer(zitem) {
        this.m_items.push(zitem);
        this.addItemtoTree(zitem);
        // Re-mark dirty after tree insertion since BBox() clears the dirty flag
        zitem.SetDirty(true);
        this.SetDirty();
        return zitem;
    }
    AddShape(shape) {
        const item = new CN_ITEM(shape, true);
        this.m_items.push(item);
        for (const point of shape.GetConnectionPoints()) {
            item.AddAnchor(point);
        }
        item.SetLayer(shape.GetLayer());
        this.addItemtoTree(item);
        // Re-mark dirty after tree insertion since BBox() clears the dirty flag
        item.SetDirty(true);
        this.SetDirty();
        return item;
    }
    addItemtoTree(item) {
        const bbox = item.BBox();
        const min = [item.StartLayer(), bbox.x, bbox.y];
        const max = [item.EndLayer(), bbox.x2, bbox.y2];
        this.m_index.Insert(min, max, item);
    }
}
