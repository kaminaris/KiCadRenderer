/*
 * This file is ported from KiCad source files:
 *   pcbnew/connectivity/connectivity_algo.h
 *   pcbnew/connectivity/connectivity_algo.cpp
 *
 * Copyright (C) 2013-2018 CERN
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version 2
 * of the License, or (at your option) any later version.
 */
import { CN_CLUSTER, CN_ZONE_LAYER, ITEM_MAP_ENTRY, LSET, KICAD_T, CN_LIST, } from './ConnectivityItems';
/**
 * Search modes for cluster building.
 */
export var CLUSTER_SEARCH_MODE;
(function (CLUSTER_SEARCH_MODE) {
    CLUSTER_SEARCH_MODE[CLUSTER_SEARCH_MODE["CSM_PROPAGATE"] = 0] = "CSM_PROPAGATE";
    CLUSTER_SEARCH_MODE[CLUSTER_SEARCH_MODE["CSM_CONNECTIVITY_CHECK"] = 1] = "CSM_CONNECTIVITY_CHECK";
    CLUSTER_SEARCH_MODE[CLUSTER_SEARCH_MODE["CSM_RATSNEST"] = 2] = "CSM_RATSNEST";
})(CLUSTER_SEARCH_MODE || (CLUSTER_SEARCH_MODE = {}));
// Enum values not present in the TS KICAD_T const (ConnectivityItems.ts),
// taken from kicad/include/core/typeinfo.h, pcbnew/footprint.h and
// pcbnew/zone_layer_override.h.
const PCB_NETINFO_T = 24;
const FP_JUST_ADDED = 0x0020;
const ZLO_FORCE_NO_ZONE_CONNECTION = 2;
const FLASHING = {
    NEVER_FLASHED: 0,
    ALWAYS_FLASHED: 1,
};
/** BBox intersection helper - mirrors BOX2I::Intersects(). */
function bboxIntersects(a, b) {
    return a.x <= b.x2 && b.x <= a.x2 && a.y <= b.y2 && b.y <= a.y2;
}
/**
 * CN_VISITOR is used by CN_CONNECTIVITY_ALGO::searchConnections() to find
 * and connect all items that are physically adjacent to a given item.
 * Mirrors KiCad's CN_VISITOR.
 */
export class CN_VISITOR {
    m_item;
    m_deferredNetCodes;
    m_seq;
    constructor(aItem, aDeferredNetCodes, aSeq) {
        this.m_item = aItem;
        this.m_deferredNetCodes = aDeferredNetCodes;
        this.m_seq = aSeq;
    }
    /**
     * @return true if the search should continue, false to stop.
     */
    Visit(aCandidate) {
        const parentA = aCandidate.Parent();
        const parentB = this.m_item.Parent();
        if (!aCandidate.Valid() || !this.m_item.Valid()) {
            return true;
        }
        if (parentA === parentB) {
            return true;
        }
        // Don't connect items in different nets that can't be changed
        if (!aCandidate.CanChangeNet() &&
            !this.m_item.CanChangeNet() &&
            aCandidate.Net() !== this.m_item.Net()) {
            return true;
        }
        // If both m_item and aCandidate are marked dirty, they will both be searched.
        // Since we are reciprocal in our connection, we arbitrarily pick one of the
        // connections to conduct the expensive search.  (The C++ compares raw item
        // pointers; here we compare the deterministic per-search sequence numbers.)
        const aSeq = this.m_seq.get(aCandidate) ?? 0;
        const bSeq = this.m_seq.get(this.m_item) ?? 0;
        if (aCandidate.Dirty() && aSeq < bSeq) {
            return true;
        }
        // We should handle zone-zone connection separately
        if (parentA.Type() === KICAD_T.PCB_ZONE_T &&
            parentB.Type() === KICAD_T.PCB_ZONE_T) {
            this.checkZoneZoneConnection(this.m_item, aCandidate);
            return true;
        }
        if (parentA.Type() === KICAD_T.PCB_ZONE_T) {
            this.checkZoneItemConnection(aCandidate, this.m_item);
            return true;
        }
        if (parentB.Type() === KICAD_T.PCB_ZONE_T) {
            this.checkZoneItemConnection(this.m_item, aCandidate);
            return true;
        }
        let commonLayers = parentA.GetLayerSet().and(parentB.GetLayerSet());
        if (typeof parentA.GetBoard === 'function') {
            const board = parentA.GetBoard();
            if (board && typeof board.GetEnabledLayers === 'function') {
                commonLayers = commonLayers.and(board.GetEnabledLayers());
            }
        }
        let connected = false;
        commonLayers.RunOnLayers((layer) => {
            if (connected) {
                return;
            }
            let flashingA = FLASHING.NEVER_FLASHED;
            let flashingB = FLASHING.NEVER_FLASHED;
            if (parentA.Type() === KICAD_T.PCB_PAD_T) {
                if (!(parentA.ConditionallyFlashed &&
                    parentA.ConditionallyFlashed(layer))) {
                    flashingA = FLASHING.ALWAYS_FLASHED;
                }
            }
            else if (parentA.Type() === KICAD_T.PCB_VIA_T) {
                if (!(parentA.ConditionallyFlashed &&
                    parentA.ConditionallyFlashed(layer))) {
                    flashingA = FLASHING.ALWAYS_FLASHED;
                }
            }
            if (parentB.Type() === KICAD_T.PCB_PAD_T) {
                if (!(parentB.ConditionallyFlashed &&
                    parentB.ConditionallyFlashed(layer))) {
                    flashingB = FLASHING.ALWAYS_FLASHED;
                }
            }
            else if (parentB.Type() === KICAD_T.PCB_VIA_T) {
                if (!(parentB.ConditionallyFlashed &&
                    parentB.ConditionallyFlashed(layer))) {
                    flashingB = FLASHING.ALWAYS_FLASHED;
                }
            }
            const shapeA = parentA.GetEffectiveShape(layer, flashingA);
            const shapeB = parentB.GetEffectiveShape(layer, flashingB);
            if (shapeA && shapeB && shapeA.Collide(shapeB)) {
                this.m_item.Connect(aCandidate);
                aCandidate.Connect(this.m_item);
                connected = true;
            }
        });
        return true;
    }
    checkZoneItemConnection(aZoneLayer, aItem) {
        const layer = aZoneLayer.GetLayer();
        const item = aItem.Parent();
        if (item.IsOnLayer && !item.IsOnLayer(layer)) {
            return;
        }
        const connect = () => {
            // We don't propagate nets from zones, so via-zone net changes are deferred
            // and applied only if the via has no higher-priority connections (tracks, pads).
            if (aItem.Parent().Type() === KICAD_T.PCB_VIA_T && aItem.CanChangeNet()) {
                this.m_deferredNetCodes.push([aItem, aZoneLayer.Net()]);
            }
            aZoneLayer.Connect(aItem);
            aItem.Connect(aZoneLayer);
        };
        // Try quick checks first...
        if (item.Type() === KICAD_T.PCB_PAD_T) {
            if (item.ConditionallyFlashed &&
                item.ConditionallyFlashed(layer) &&
                item.GetZoneLayerOverride &&
                item.GetZoneLayerOverride(layer) === ZLO_FORCE_NO_ZONE_CONNECTION) {
                return;
            }
            // Don't connect zones to pads on backdrilled or post-machined layers
            if (item.IsBackdrilledOrPostMachined && item.IsBackdrilledOrPostMachined(layer)) {
                return;
            }
        }
        else if (item.Type() === KICAD_T.PCB_VIA_T) {
            if (item.ConditionallyFlashed &&
                item.ConditionallyFlashed(layer) &&
                item.GetZoneLayerOverride &&
                item.GetZoneLayerOverride(layer) === ZLO_FORCE_NO_ZONE_CONNECTION) {
                return;
            }
            // Don't connect zones to vias on backdrilled or post-machined layers
            if (item.IsBackdrilledOrPostMachined && item.IsBackdrilledOrPostMachined(layer)) {
                return;
            }
        }
        for (let i = 0; i < aItem.AnchorCount(); ++i) {
            if (aZoneLayer.ContainsPoint(aItem.GetAnchor(i))) {
                connect();
                return;
            }
        }
        if (item.Type() === KICAD_T.PCB_VIA_T || item.Type() === KICAD_T.PCB_PAD_T) {
            // As long as the pad/via crosses the zone layer, check for the full
            // effective shape.  We check for the overlapping layers above.
            const shape = item.GetEffectiveShape
                ? item.GetEffectiveShape(layer, FLASHING.ALWAYS_FLASHED)
                : null;
            if (shape && aZoneLayer.Collide(shape)) {
                connect();
            }
            return;
        }
        const shape = item.GetEffectiveShape ? item.GetEffectiveShape(layer) : null;
        if (shape && aZoneLayer.Collide(shape)) {
            connect();
        }
    }
    checkZoneZoneConnection(aZoneLayerA, aZoneLayerB) {
        // CN_ZONE_LAYER now caches its own copy of the outline, so we just check if it's non-empty.
        if (!aZoneLayerA.HasValidOutline() || !aZoneLayerB.HasValidOutline()) {
            return;
        }
        const boxA = aZoneLayerA.BBox();
        const boxB = aZoneLayerB.BBox();
        const layer = aZoneLayerA.GetLayer();
        if (aZoneLayerB.GetLayer() !== layer) {
            return;
        }
        if (!bboxIntersects(boxA, boxB)) {
            return;
        }
        const outlineA = aZoneLayerA.GetOutline();
        for (let i = 0; i < outlineA.length; i++) {
            const pt = outlineA[i];
            if (!boxB.containsPoint(pt)) {
                continue;
            }
            if (aZoneLayerB.ContainsPoint(pt)) {
                aZoneLayerA.Connect(aZoneLayerB);
                aZoneLayerB.Connect(aZoneLayerA);
                return;
            }
        }
        const outlineB = aZoneLayerB.GetOutline();
        for (let i = 0; i < outlineB.length; i++) {
            const pt = outlineB[i];
            if (!boxA.containsPoint(pt)) {
                continue;
            }
            if (aZoneLayerA.ContainsPoint(pt)) {
                aZoneLayerA.Connect(aZoneLayerB);
                aZoneLayerB.Connect(aZoneLayerA);
                return;
            }
        }
    }
}
/**
 * CN_CONNECTIVITY_ALGO manages the connectivity database.
 * Mirrors KiCad's CN_CONNECTIVITY_ALGO.
 */
export class CN_CONNECTIVITY_ALGO {
    m_parentConnectivityData;
    m_itemList = new CN_LIST();
    m_itemMap = new Map();
    m_connClusters = [];
    m_ratsnestClusters = [];
    m_dirtyNets = [];
    m_isLocal = false;
    m_globalConnectivityData = null;
    m_progressReporter = null;
    constructor(aParentConnectivityData) {
        this.m_parentConnectivityData = aParentConnectivityData;
        this.m_isLocal = false;
    }
    ItemExists(aItem) {
        return this.m_itemMap.has(aItem);
    }
    ItemEntry(aItem) {
        let entry = this.m_itemMap.get(aItem);
        if (!entry) {
            entry = new ITEM_MAP_ENTRY();
            this.m_itemMap.set(aItem, entry);
        }
        return entry;
    }
    IsNetDirty(aNet) {
        if (aNet < 0) {
            return false;
        }
        return this.m_dirtyNets[aNet] === true;
    }
    ClearDirtyFlags() {
        for (let ii = 0; ii < this.m_dirtyNets.length; ii++) {
            this.m_dirtyNets[ii] = false;
        }
    }
    GetDirtyClusters(aClusters) {
        for (const cl of this.m_ratsnestClusters) {
            const net = cl.OriginNet();
            if (net >= 0 && this.IsNetDirty(net)) {
                aClusters.push(cl);
            }
        }
    }
    NetCount() {
        return this.m_dirtyNets.length;
    }
    /**
     * Build the connectivity database for the entire board.
     * Generates CN_ZONE_LAYER items for each zone island on each layer,
     * then adds tracks, pads, and shapes.
     */
    Build(aBoard, aReporter = null) {
        // Generate CN_ZONE_LAYERs for each island on each layer of each zone
        const zitems = [];
        for (const zone of aBoard.Zones()) {
            if (zone.IsOnCopperLayer && zone.IsOnCopperLayer()) {
                this.m_itemMap.set(zone, new ITEM_MAP_ENTRY());
                this.markItemNetAsDirty(zone);
                // Don't check for connections on layers that only exist in the zone
                // but were disabled in the board
                const board = typeof zone.GetBoard === 'function' ? zone.GetBoard() : aBoard;
                let layerset = typeof zone.LayerSet === 'function' ? zone.LayerSet() : new LSET();
                if (board && typeof board.GetEnabledLayers === 'function') {
                    layerset = board.GetEnabledLayers().and(layerset);
                }
                layerset = layerset.and(new LSET().AllCuMask());
                layerset.RunOnLayers((layer) => {
                    const fillPolys = zone.GetFilledPolysList(layer);
                    if (fillPolys) {
                        for (let j = 0; j < fillPolys.OutlineCount(); j++) {
                            zitems.push(new CN_ZONE_LAYER(zone, layer, j));
                        }
                    }
                });
            }
        }
        // Setup progress metrics
        let progressDelta = 50;
        let size = 0.0;
        size += zitems.length; // Once for building RTrees
        size += zitems.length; // Once for adding to connectivity
        size += aBoard.Tracks().length;
        size += aBoard.Drawings().length;
        for (const footprint of aBoard.Footprints()) {
            size += footprint.Pads().length;
        }
        size *= 1.5; // Our caller gets the other third of the progress bar
        progressDelta = Math.max(progressDelta, Math.floor(size / 4));
        const report = (progress) => {
            if (aReporter && progress % progressDelta === 0) {
                aReporter.SetCurrentProgress(progress / size);
                if (aReporter.KeepRefreshing) {
                    aReporter.KeepRefreshing(false);
                }
            }
        };
        // Generate RTrees for CN_ZONE_LAYER items (single-threaded port of
        // KiCad's parallel task loop)
        for (const zitem of zitems) {
            if (aReporter && aReporter.IsCancelled && aReporter.IsCancelled()) {
                return;
            }
            zitem.BuildRTree();
            if (aReporter && aReporter.AdvanceProgress) {
                aReporter.AdvanceProgress();
            }
        }
        // Add CN_ZONE_LAYERS, tracks, and pads to connectivity
        let ii = zitems.length;
        for (const zitem of zitems) {
            this.m_itemList.AddZoneLayer(zitem);
            this.m_itemMap.get(zitem.Parent())?.Link(zitem);
            report(++ii);
        }
        for (const tv of aBoard.Tracks()) {
            this.Add(tv);
            report(++ii);
        }
        for (const footprint of aBoard.Footprints()) {
            for (const pad of footprint.Pads()) {
                this.Add(pad);
                report(++ii);
            }
        }
        for (const drawing of aBoard.Drawings()) {
            if (drawing.IsOnCopperLayer && drawing.IsOnCopperLayer()) {
                this.Add(drawing);
            }
            report(++ii);
        }
        if (aReporter) {
            aReporter.SetCurrentProgress(ii / size);
            if (aReporter.KeepRefreshing) {
                aReporter.KeepRefreshing(false);
            }
        }
    }
    LocalBuild(aGlobalConnectivity, aLocalItems) {
        this.m_isLocal = true;
        this.m_globalConnectivityData = aGlobalConnectivity;
        for (const item of aLocalItems) {
            switch (item.Type()) {
                case KICAD_T.PCB_TRACE_T:
                case KICAD_T.PCB_ARC_T:
                case KICAD_T.PCB_VIA_T:
                case KICAD_T.PCB_PAD_T:
                case KICAD_T.PCB_FOOTPRINT_T:
                case KICAD_T.PCB_SHAPE_T:
                    this.Add(item);
                    break;
                default:
                    break;
            }
        }
    }
    Clear() {
        this.m_ratsnestClusters = [];
        this.m_connClusters = [];
        this.m_itemMap.clear();
        this.m_itemList.Clear();
    }
    Remove(aItem) {
        let anythingDeleted = false;
        this.markItemNetAsDirty(aItem);
        switch (aItem.Type()) {
            case KICAD_T.PCB_FOOTPRINT_T:
                for (const pad of aItem.Pads()) {
                    if (this.m_itemMap.has(pad)) {
                        this.m_itemMap.get(pad)?.MarkItemsAsInvalid();
                        this.m_itemMap.delete(pad);
                        anythingDeleted = true;
                    }
                }
                this.m_itemList.SetDirty(true);
                break;
            case KICAD_T.PCB_PAD_T:
            case KICAD_T.PCB_TRACE_T:
            case KICAD_T.PCB_ARC_T:
            case KICAD_T.PCB_VIA_T:
            case KICAD_T.PCB_ZONE_T:
            case KICAD_T.PCB_SHAPE_T:
                if (this.m_itemMap.has(aItem)) {
                    this.m_itemMap.get(aItem)?.MarkItemsAsInvalid();
                    this.m_itemMap.delete(aItem);
                    this.m_itemList.SetDirty(true);
                    anythingDeleted = true;
                }
                break;
            default:
                return false;
        }
        // Once we delete an item, it may connect between lists, so mark both as
        // potentially invalid
        if (anythingDeleted) {
            this.m_itemList.SetHasInvalid(true);
        }
        return true;
    }
    RemoveItem(aItem) {
        return this.Remove(aItem);
    }
    Add(aItem) {
        if (!aItem.IsOnCopperLayer || !aItem.IsOnCopperLayer()) {
            return false;
        }
        const alreadyAdded = (item) => {
            const it = this.m_itemMap.get(item);
            if (!it) {
                return false;
            }
            // Don't be fooled by an empty ITEM_MAP_ENTRY auto-created by operator[].
            return it.GetItems().length > 0;
        };
        switch (aItem.Type()) {
            case PCB_NETINFO_T:
                this.MarkNetAsDirty(aItem.GetNetCode());
                break;
            case KICAD_T.PCB_FOOTPRINT_T:
                if (aItem.GetAttributes && aItem.GetAttributes() & FP_JUST_ADDED) {
                    return false;
                }
                for (const pad of aItem.Pads()) {
                    if (alreadyAdded(pad)) {
                        return false;
                    }
                    this.add(pad);
                }
                break;
            case KICAD_T.PCB_PAD_T: {
                const fp = aItem.GetParentFootprint ? aItem.GetParentFootprint() : null;
                if (fp && fp.GetAttributes && fp.GetAttributes() & FP_JUST_ADDED) {
                    return false;
                }
                if (alreadyAdded(aItem)) {
                    return false;
                }
                this.add(aItem);
                break;
            }
            case KICAD_T.PCB_TRACE_T:
                if (alreadyAdded(aItem)) {
                    return false;
                }
                this.add(aItem);
                break;
            case KICAD_T.PCB_ARC_T:
                if (alreadyAdded(aItem)) {
                    return false;
                }
                this.add(aItem);
                break;
            case KICAD_T.PCB_VIA_T:
                if (alreadyAdded(aItem)) {
                    return false;
                }
                this.add(aItem);
                break;
            case KICAD_T.PCB_SHAPE_T:
                if (alreadyAdded(aItem)) {
                    return false;
                }
                if (!this.isCopperLayer(aItem.GetLayer())) {
                    return false;
                }
                this.add(aItem);
                break;
            case KICAD_T.PCB_ZONE_T: {
                if (alreadyAdded(aItem)) {
                    return false;
                }
                this.m_itemMap.set(aItem, new ITEM_MAP_ENTRY());
                // Don't check for connections on layers that only exist in the zone
                // but were disabled in the board
                const board = typeof aItem.GetBoard === 'function' ? aItem.GetBoard() : null;
                let layerset = typeof aItem.LayerSet === 'function' ? aItem.LayerSet() : new LSET();
                if (board && typeof board.GetEnabledLayers === 'function') {
                    layerset = board.GetEnabledLayers().and(layerset);
                }
                layerset.RunOnLayers((layer) => {
                    for (const zitem of this.m_itemList.AddZone(aItem, layer)) {
                        this.ItemEntry(aItem).Link(zitem);
                    }
                });
                break;
            }
            default:
                return false;
        }
        this.markItemNetAsDirty(aItem);
        return true;
    }
    AddItem(aItem) {
        return this.Add(aItem);
    }
    /** Dispatches a BOARD_ITEM to the correct CN_LIST adder by type. */
    add(brditem) {
        switch (brditem.Type()) {
            case KICAD_T.PCB_TRACE_T:
                this.m_itemMap.set(brditem, new ITEM_MAP_ENTRY(this.m_itemList.AddTrack(brditem)));
                break;
            case KICAD_T.PCB_ARC_T:
                this.m_itemMap.set(brditem, new ITEM_MAP_ENTRY(this.m_itemList.AddArc(brditem)));
                break;
            case KICAD_T.PCB_VIA_T:
                this.m_itemMap.set(brditem, new ITEM_MAP_ENTRY(this.m_itemList.AddVia(brditem)));
                break;
            case KICAD_T.PCB_PAD_T:
                this.m_itemMap.set(brditem, new ITEM_MAP_ENTRY(this.m_itemList.Add(brditem)));
                break;
            case KICAD_T.PCB_SHAPE_T:
                this.m_itemMap.set(brditem, new ITEM_MAP_ENTRY(this.m_itemList.AddShape(brditem)));
                break;
            default:
                break;
        }
    }
    /** Mirrors IsCopperLayer( aLayer ). */
    isCopperLayer(aLayer) {
        return aLayer === 0 /* F_Cu */ || aLayer === 2 /* B_Cu */;
    }
    RemoveInvalidRefs() {
        for (const item of this.m_itemList) {
            item.RemoveInvalidRefs();
        }
    }
    markItemNetAsDirty(aItem) {
        if (aItem.IsConnected && aItem.IsConnected()) {
            this.MarkNetAsDirty(aItem.GetNetCode());
        }
        else if (aItem.Type() === KICAD_T.PCB_FOOTPRINT_T) {
            for (const pad of aItem.Pads()) {
                this.MarkNetAsDirty(pad.GetNetCode());
            }
        }
    }
    MarkNetAsDirty(aNet) {
        if (aNet < 0) {
            return;
        }
        if (this.m_dirtyNets.length <= aNet) {
            let lastNet = this.m_dirtyNets.length - 1;
            if (lastNet < 0) {
                lastNet = 0;
            }
            this.m_dirtyNets.length = aNet + 1;
            for (let i = lastNet; i < aNet + 1; i++) {
                this.m_dirtyNets[i] = true;
            }
        }
        this.m_dirtyNets[aNet] = true;
    }
    SetProgressReporter(aReporter) {
        this.m_progressReporter = aReporter;
    }
    GetRatsnestForNet(aNet) {
        const parent = this.m_parentConnectivityData;
        if (!parent) {
            return null;
        }
        const nets = parent.m_nets ?? [];
        for (const net of nets) {
            if (net.m_net === aNet) {
                return net;
            }
        }
        return null;
    }
    searchConnections() {
        const garbage = [];
        if (this.m_parentConnectivityData) {
            this.m_parentConnectivityData.RemoveInvalidRefs();
        }
        if (this.m_isLocal && this.m_globalConnectivityData) {
            this.m_globalConnectivityData.RemoveInvalidRefs();
        }
        this.m_itemList.RemoveInvalidItems(garbage);
        const dirtyItems = [];
        for (const item of this.m_itemList) {
            if (item.Dirty()) {
                dirtyItems.push(item);
            }
        }
        if (this.m_progressReporter && this.m_progressReporter.SetMaxProgress) {
            this.m_progressReporter.SetMaxProgress(dirtyItems.length);
            if (this.m_progressReporter.KeepRefreshing &&
                !this.m_progressReporter.KeepRefreshing()) {
                return;
            }
        }
        if (this.m_itemList.IsDirty()) {
            // Collect deferred net code changes.  In KiCad these are gathered
            // during the parallel search; here the search is single-threaded so
            // the collection is just a plain array.
            const deferredNetCodes = [];
            // Assign deterministic sequence numbers so the visitor can implement
            // the C++ raw-pointer comparison ("aCandidate < m_item").
            const seq = new Map();
            let n = 0;
            for (const item of dirtyItems) {
                seq.set(item, n++);
            }
            for (let ii = 0; ii < dirtyItems.length; ++ii) {
                const item = dirtyItems[ii];
                const visitor = new CN_VISITOR(item, deferredNetCodes, seq);
                this.m_itemList.FindNearby(item, (candidate) => visitor.Visit(candidate));
            }
            // Apply deferred zone net changes, but only for vias that have no non-zone
            // connections.  Tracks and pads take priority over zones for net assignment;
            // cluster-based propagation will handle those vias.
            //
            // A single via can touch zones of several different nets.  The order in
            // which those candidate nets are collected depends on the search and is
            // not stable across connectivity rebuilds, so we must not simply pick the
            // first one.  Instead, if the via's existing net matches any zone it
            // touches, we keep it.  This preserves a deliberately-assigned net and only
            // falls back to a deterministic choice (lowest net code) when the current
            // net no longer touches any zone.
            deferredNetCodes.sort((a, b) => (seq.get(a[0]) ?? 0) - (seq.get(b[0]) ?? 0));
            let it = 0;
            while (it < deferredNetCodes.length) {
                const cnItem = deferredNetCodes[it][0];
                // Entries for the same via are contiguous after the sort above.
                let groupEnd = it;
                while (groupEnd < deferredNetCodes.length &&
                    deferredNetCodes[groupEnd][0] === cnItem) {
                    ++groupEnd;
                }
                let hasNonZone = false;
                for (const c of cnItem.ConnectedItems()) {
                    if (c.Parent().Type() !== KICAD_T.PCB_ZONE_T) {
                        hasNonZone = true;
                        break;
                    }
                }
                if (hasNonZone) {
                    // Connected to a track or pad, so cluster propagation owns the net.
                    it = groupEnd;
                    continue;
                }
                const existingNet = cnItem.Parent().GetNetCode();
                let keepExisting = false;
                let bestNet = Number.MAX_SAFE_INTEGER;
                for (let entry = it; entry < groupEnd; ++entry) {
                    if (deferredNetCodes[entry][1] === existingNet) {
                        keepExisting = true;
                        break;
                    }
                    bestNet = Math.min(bestNet, deferredNetCodes[entry][1]);
                }
                if (!keepExisting && cnItem.Parent().SetNetCode) {
                    cnItem.Parent().SetNetCode(bestNet);
                }
                it = groupEnd;
            }
        }
        this.m_itemList.ClearDirtyFlags();
    }
    SearchClusters(aMode, aExcludeZones = false, aSingleNet = -1) {
        // Mirrors KiCad's single-argument overload: when only aMode is passed,
        // zones are excluded iff we are in propagate mode.
        if (arguments.length === 1) {
            aExcludeZones = aMode === CLUSTER_SEARCH_MODE.CSM_PROPAGATE;
        }
        const withinAnyNet = aMode !== CLUSTER_SEARCH_MODE.CSM_PROPAGATE;
        const Q = [];
        const itemSet = new Set();
        const clusters = [];
        if (this.m_itemList.IsDirty()) {
            this.searchConnections();
        }
        const visited = new Set();
        const addToSearchList = (aItem) => {
            if (withinAnyNet && aItem.Net() <= 0) {
                return;
            }
            if (!aItem.Valid()) {
                return;
            }
            if (aSingleNet >= 0 && aItem.Net() !== aSingleNet) {
                return;
            }
            if (aExcludeZones && aItem.Parent().Type() === KICAD_T.PCB_ZONE_T) {
                return;
            }
            itemSet.add(aItem);
        };
        for (const item of this.m_itemList) {
            addToSearchList(item);
        }
        if (this.m_progressReporter && this.m_progressReporter.IsCancelled && this.m_progressReporter.IsCancelled()) {
            return clusters;
        }
        while (itemSet.size > 0) {
            const cluster = new CN_CLUSTER();
            let root = null;
            for (const it of itemSet) {
                if (visited.has(it)) {
                    itemSet.delete(it);
                }
                else {
                    root = it;
                    break;
                }
            }
            if (!root) {
                break;
            }
            visited.add(root);
            Q.length = 0;
            Q.push(root);
            while (Q.length > 0) {
                const current = Q.shift();
                cluster.Add(current);
                for (const n of current.ConnectedItems()) {
                    if (withinAnyNet && n.Net() !== root.Net()) {
                        continue;
                    }
                    if (aExcludeZones && n.Parent().Type() === KICAD_T.PCB_ZONE_T) {
                        continue;
                    }
                    if (!visited.has(n) && n.Valid()) {
                        visited.add(n);
                        Q.push(n);
                    }
                }
            }
            clusters.push(cluster);
        }
        clusters.sort((a, b) => a.OriginNet() - b.OriginNet());
        return clusters;
    }
    GetClusters() {
        this.m_ratsnestClusters = this.SearchClusters(CLUSTER_SEARCH_MODE.CSM_RATSNEST);
        return this.m_ratsnestClusters;
    }
    PropagateNets(aCommit = null) {
        this.updateJumperPads();
        this.m_connClusters = this.SearchClusters(CLUSTER_SEARCH_MODE.CSM_PROPAGATE);
        this.propagateConnections(aCommit);
    }
    propagateConnections(aCommit = null) {
        for (const cluster of this.m_connClusters) {
            if (cluster.IsConflicting()) {
                // Conflicting pads in cluster: we don't know the user's intent so best
                // to do nothing.
                console.warn('Conflicting pads in cluster; skipping propagation');
            }
            else if (cluster.HasValidNet()) {
                // Propagate from the origin (will be a pad if there are any, or another
                // item if there are no pads).
                let n_changed = 0;
                for (const item of cluster) {
                    if (item.Valid() &&
                        item.CanChangeNet() &&
                        item.Parent().GetNetCode() !== cluster.OriginNet()) {
                        this.MarkNetAsDirty(item.Parent().GetNetCode());
                        this.MarkNetAsDirty(cluster.OriginNet());
                        if (aCommit && aCommit.Modify) {
                            aCommit.Modify(item.Parent());
                        }
                        if (item.Parent().SetNetCode) {
                            item.Parent().SetNetCode(cluster.OriginNet());
                        }
                        n_changed++;
                    }
                }
                if (n_changed) {
                    console.warn('Cluster: net:', cluster.OriginNet(), cluster.OriginNetName());
                }
                else {
                    console.warn('Cluster: no changeable items to propagate to');
                }
            }
            else {
                console.warn('Cluster: connected to unused net');
            }
        }
    }
    updateJumperPads() {
        // Map of footprint -> map of pad number -> list of CN_ITEMs for pads with
        // that number
        const padsByFootprint = new Map();
        for (const item of this.m_itemList) {
            if (!item.Valid() || item.Parent().Type() !== KICAD_T.PCB_PAD_T) {
                continue;
            }
            const pad = item.Parent();
            const fp = pad.GetParentFootprint ? pad.GetParentFootprint() : null;
            if (!fp) {
                continue;
            }
            if (!padsByFootprint.has(fp)) {
                padsByFootprint.set(fp, new Map());
            }
            const padsMap = padsByFootprint.get(fp);
            const num = pad.GetNumber ? pad.GetNumber() : '';
            if (!padsMap.has(num)) {
                padsMap.set(num, []);
            }
            padsMap.get(num).push(item);
        }
        for (const [footprint, padsMap] of padsByFootprint) {
            if (footprint.GetDuplicatePadNumbersAreJumpers &&
                footprint.GetDuplicatePadNumbersAreJumpers()) {
                for (const padsList of padsMap.values()) {
                    for (let i = 0; i < padsList.length; ++i) {
                        for (let j = 1; j < padsList.length; ++j) {
                            padsList[i].Connect(padsList[j]);
                            padsList[j].Connect(padsList[i]);
                        }
                    }
                }
            }
            const groups = footprint.JumperPadGroups ? footprint.JumperPadGroups() : [];
            for (const group of groups) {
                const toConnect = [];
                for (const padNumber of group) {
                    const pads = padsMap.get(padNumber);
                    if (pads) {
                        for (const p of pads) {
                            toConnect.push(p);
                        }
                    }
                }
                for (let i = 0; i < toConnect.length; ++i) {
                    for (let j = 1; j < toConnect.length; ++j) {
                        toConnect[i].Connect(toConnect[j]);
                        toConnect[j].Connect(toConnect[i]);
                    }
                }
            }
        }
    }
}
