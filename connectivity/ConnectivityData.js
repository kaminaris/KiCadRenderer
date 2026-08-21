/*
 * This file is ported from KiCad source files:
 *   pcbnew/connectivity/connectivity_data.h
 *   pcbnew/connectivity/connectivity_data.cpp
 *
 * Copyright (C) 2013-2017 CERN
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version 2
 * of the License, or (at your option) any later version.
 */
import { CN_ZONE_LAYER, KICAD_T, } from "./ConnectivityItems";
import { RN_NET } from "./RatsnestData";
import { CN_CONNECTIVITY_ALGO } from "./ConnectivityAlgo";
export class CONNECTIVITY_DATA {
    m_connAlgo;
    m_nets = [];
    m_dirtyNets = [];
    m_netcodeMap = new Map();
    m_progressReporter = null;
    m_netSettings = null;
    m_isLocal = false;
    m_globalConnectivityData = null;
    m_skipRatsnestUpdate = false;
    constructor() {
        this.m_connAlgo = new CN_CONNECTIVITY_ALGO(this);
        this.m_skipRatsnestUpdate = false;
    }
    Build(aBoard, aReporter = null) {
        this.m_connAlgo = new CN_CONNECTIVITY_ALGO(this);
        this.m_connAlgo.Build(aBoard, aReporter);
        this.RefreshNetcodeMap(aBoard);
        this.internalRecalculateRatsnest();
        return true;
    }
    LocalBuild(aGlobalConnectivity, aLocalItems) {
        this.m_isLocal = true;
        this.m_globalConnectivityData = aGlobalConnectivity;
        this.m_connAlgo = new CN_CONNECTIVITY_ALGO(this);
        this.m_connAlgo.LocalBuild(aGlobalConnectivity, aLocalItems);
    }
    Add(aItem) {
        return this.m_connAlgo.Add(aItem);
    }
    Remove(aItem) {
        return this.m_connAlgo.RemoveItem(aItem);
    }
    Update(aItem) {
        this.m_connAlgo.RemoveItem(aItem);
        return this.Add(aItem);
    }
    ClearRatsnest() {
        this.m_nets = [];
        this.m_dirtyNets = [];
        this.m_connAlgo.Clear();
    }
    GetNetCount() {
        return this.m_connAlgo.NetCount();
    }
    /** Mirrors CONNECTIVITY_DATA::GetRatsnestForNet(). */
    GetRatsnestForNet(aNet) {
        if (aNet < 0 || aNet >= this.m_nets.length) {
            return null;
        }
        return this.m_nets[aNet] ?? null;
    }
    PropagateNets(aCommit = null) {
        this.m_connAlgo.PropagateNets(aCommit);
    }
    RecalculateRatsnest(aCommit = null) {
        this.internalRecalculateRatsnest(aCommit);
    }
    /** Mirrors CONNECTIVITY_DATA::updateRatsnest() — recompute all dirty nets
     * with nodes, then optimize edge ends. Single-threaded port of KiCad's
     * parallel task loops; same iteration order. */
    updateRatsnest() {
        // Start with net 1 as net 0 is reserved for not-connected.
        // Nets without nodes are also ignored.
        const dirtyNets = [];
        for (let i = 1; i < this.m_nets.length; i++) {
            const net = this.m_nets[i];
            if (net.IsDirty() && net.GetNodeCount() > 0) {
                dirtyNets.push(net);
            }
        }
        for (const net of dirtyNets) {
            net.UpdateNet();
        }
        for (const net of dirtyNets) {
            net.OptimizeRNEdges();
        }
    }
    /** Mirrors CONNECTIVITY_DATA::addRatsnestCluster(). */
    addRatsnestCluster(aCluster) {
        const rnNet = this.m_nets[aCluster.OriginNet()];
        rnNet.AddCluster(aCluster);
    }
    internalRecalculateRatsnest(aCommit = null) {
        if (this.m_skipRatsnestUpdate) {
            return;
        }
        this.m_connAlgo.PropagateNets(aCommit);
        const lastNet = this.m_connAlgo.NetCount();
        if (lastNet >= this.m_nets.length) {
            const prevSize = this.m_nets.length;
            this.m_nets.length = lastNet + 1;
            for (let i = prevSize; i < this.m_nets.length; i++) {
                this.m_nets[i] = new RN_NET(i);
            }
        }
        else {
            for (let ii = lastNet; ii < this.m_nets.length; ++ii) {
                this.m_nets[ii]?.Clear();
            }
        }
        const clusters = this.m_connAlgo.GetClusters();
        for (let net = 0; net < lastNet; net++) {
            if (this.m_connAlgo.IsNetDirty(net)) {
                this.m_nets[net]?.Clear();
            }
        }
        for (const c of clusters) {
            const net = c.OriginNet();
            // Don't add intentionally-kept zone islands to the ratsnest
            if (c.IsOrphaned() && c.Size() === 1) {
                let first = null;
                for (const it of c) {
                    first = it;
                    break;
                }
                if (first instanceof CN_ZONE_LAYER) {
                    continue;
                }
            }
            if (this.m_connAlgo.IsNetDirty(net)) {
                this.addRatsnestCluster(c);
            }
        }
        this.m_connAlgo.ClearDirtyFlags();
        if (!this.m_skipRatsnestUpdate) {
            this.updateRatsnest();
        }
    }
    /** Mirrors CONNECTIVITY_DATA::GetRatsnestForItems(). */
    GetRatsnestForItems(aItems) {
        const nets = new Set();
        const edges = [];
        const itemSet = new Set();
        for (const item of aItems) {
            if (item.Type() === KICAD_T.PCB_FOOTPRINT_T) {
                for (const pad of item.Pads()) {
                    nets.add(pad.GetNetCode());
                    itemSet.add(pad);
                }
            }
            else if (item.IsConnected()) {
                itemSet.add(item);
                nets.add(item.GetNetCode());
            }
        }
        for (const netcode of nets) {
            const net = this.GetRatsnestForNet(netcode);
            if (!net) {
                continue;
            }
            for (const edge of net.GetEdges()) {
                const srcNode = edge.GetSourceNode();
                const dstNode = edge.GetTargetNode();
                if (!srcNode || srcNode.Dirty() || !dstNode || dstNode.Dirty()) {
                    continue;
                }
                const srcParent = srcNode.Parent();
                const dstParent = dstNode.Parent();
                const srcFound = itemSet.has(srcParent);
                const dstFound = itemSet.has(dstParent);
                if (srcFound && dstFound) {
                    edges.push(edge);
                }
            }
        }
        return edges;
    }
    /** Mirrors CONNECTIVITY_DATA::GetRatsnestForPad(). */
    GetRatsnestForPad(aPad) {
        const edges = [];
        const net = this.GetRatsnestForNet(aPad.GetNetCode());
        if (!net) {
            return edges;
        }
        for (const edge of net.GetEdges()) {
            const srcNode = edge.GetSourceNode();
            const dstNode = edge.GetTargetNode();
            if (!srcNode || srcNode.Dirty()) {
                continue;
            }
            if (!dstNode || dstNode.Dirty()) {
                continue;
            }
            if (srcNode.Parent() === aPad || dstNode.Parent() === aPad) {
                edges.push(edge);
            }
        }
        return edges;
    }
    GetUnconnectedCount() {
        let count = 0;
        for (const cluster of this.m_connAlgo.GetClusters()) {
            if (cluster.OriginNet() < 0) {
                count++;
            }
        }
        return count;
    }
    SetProgressReporter(aReporter) {
        this.m_progressReporter = aReporter;
        this.m_connAlgo.SetProgressReporter(aReporter);
    }
    RefreshNetcodeMap(aBoard) {
        this.m_netcodeMap.clear();
        const netInfo = aBoard.GetNetInfo ? aBoard.GetNetInfo() : [];
        for (const net of netInfo) {
            this.m_netcodeMap.set(net.GetNetCode(), net.GetNetname());
        }
    }
    GetNetSettings() {
        return this.m_netSettings;
    }
    /** Mirrors CONNECTIVITY_DATA::MarkItemNetAsDirty(). */
    MarkItemNetAsDirty(aItem) {
        if (aItem.Type() === KICAD_T.PCB_FOOTPRINT_T) {
            for (const pad of aItem.Pads()) {
                this.m_connAlgo.MarkNetAsDirty(pad.GetNetCode());
            }
        }
        if (aItem.IsConnected()) {
            this.m_connAlgo.MarkNetAsDirty(aItem.GetNetCode());
        }
    }
    /** Mirrors CONNECTIVITY_DATA::RemoveInvalidRefs(). */
    RemoveInvalidRefs() {
        this.m_connAlgo.RemoveInvalidRefs();
        for (const rnNet of this.m_nets) {
            rnNet?.RemoveInvalidRefs();
        }
    }
    GetClusters() {
        return this.m_connAlgo.GetClusters();
    }
    GetConnectivityAlgo() {
        return this.m_connAlgo;
    }
}
