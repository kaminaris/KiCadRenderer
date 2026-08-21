/*
 * Ported from KiCad kimath/include/geometry/rtree/dynamic_rtree.h.
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version 3
 * of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * NOTES ON THE PORT:
 *  - Identical R*-tree algorithm (Insert/Remove/Search/RemoveAll, forced
 *    reinsert, R*-split by perimeter then overlap) with the same method
 *    names as the C++.
 *  - The slab allocator and the SIMD ChildOverlapMask are not ported (see
 *    RtreeNode.ts); plain allocation and scalar loops instead.
 *  - BulkLoad (Hilbert packing) and NearestNeighbors are not used by
 *    CN_RTREE/connectivity, so they are omitted.
 */
import { RTREE_NODE, INT64_MAX, INT64_MIN } from './RtreeNode';
/**
 * Dynamic R*-tree.
 *
 * Supports O(log N) insert, remove, and query operations. Uses R*-tree split
 * and forced reinsert heuristics for optimal tree quality.
 *
 * @param DATATYPE  Type of data stored in leaf nodes
 * @param NUMDIMS   Number of dimensions (3: layer, x, y)
 * @param TMAXNODES Maximum children per node (fanout)
 */
export class DYNAMIC_RTREE {
    NUMDIMS;
    MAXNODES;
    // Fraction of entries to reinsert on overflow (30% per R*-tree paper)
    REINSERT_COUNT;
    MINNODES;
    m_root = null;
    m_count = 0;
    constructor(NUMDIMS = 3, MAXNODES = 16) {
        this.NUMDIMS = NUMDIMS;
        this.MAXNODES = MAXNODES;
        this.MINNODES = RTREE_NODE.MINNODES_FROM(MAXNODES);
        this.REINSERT_COUNT = Math.floor((MAXNODES * 3) / 10);
    }
    /**
     * Insert an item with the given bounding box.
     */
    Insert(aMin, aMax, aData) {
        if (!this.m_root) {
            this.m_root = new RTREE_NODE(this.NUMDIMS, this.MAXNODES);
            this.m_root.level = 0;
        }
        // Bitmask tracking which levels have had forced reinsert this insertion.
        // Boxed to mirror the C++ uint32_t& out-parameter.
        const reinsertedLevels = { value: 0 };
        this.insertImpl(aMin, aMax, aData, reinsertedLevels);
        this.m_count++;
    }
    /**
     * Remove an item using its stored insertion bounding box.
     *
     * @return true if the item was found and removed, false otherwise
     */
    Remove(aMin, aMax, aData) {
        if (!this.m_root) {
            return false;
        }
        // Try removal using the provided bbox first
        let reinsertList = [];
        if (this.removeImpl(this.m_root, aMin, aMax, aData, reinsertList)) {
            this.m_count--;
            this.reinsertOrphans(reinsertList);
            this.condenseRoot();
            return true;
        }
        // Fall back to full-tree search using stored insertion bboxes
        const fullMin = new Array(this.NUMDIMS).fill(INT64_MIN);
        const fullMax = new Array(this.NUMDIMS).fill(INT64_MAX);
        reinsertList = [];
        if (this.removeImpl(this.m_root, fullMin, fullMax, aData, reinsertList)) {
            this.m_count--;
            this.reinsertOrphans(reinsertList);
            this.condenseRoot();
            return true;
        }
        return false;
    }
    /**
     * Search for items whose bounding boxes overlap the query rectangle.
     *
     * @param aMin     Minimum corner of query rectangle
     * @param aMax     Maximum corner of query rectangle
     * @param aVisitor Callback invoked for each matching item. Return false to stop early.
     * @return Number of items reported to visitor
     */
    Search(aMin, aMax, aVisitor) {
        // Boxed to mirror the C++ int& out-parameter.
        const found = { value: 0 };
        if (this.m_root) {
            this.searchImpl(this.m_root, aMin, aMax, aVisitor, found);
        }
        return found.value;
    }
    /**
     * Remove all items from the tree.
     */
    RemoveAll() {
        this.removeAllNodes(this.m_root);
        this.m_root = null;
        this.m_count = 0;
    }
    empty() {
        return this.m_count === 0;
    }
    allocNode() {
        return new RTREE_NODE(this.NUMDIMS, this.MAXNODES);
    }
    freeNode(_aNode) {
        // GC handles deallocation — kept for name parity with the C++.
    }
    removeAllNodes(aNode) {
        if (!aNode) {
            return;
        }
        if (aNode.IsInternal()) {
            for (let i = 0; i < aNode.count; ++i) {
                this.removeAllNodes(aNode.children[i]);
            }
        }
        this.freeNode(aNode);
    }
    /**
     * Core insertion with forced reinsert tracking.
     */
    insertImpl(aMin, aMax, aData, reinsertedLevels) {
        // ChooseSubtree to find the leaf
        const path = [];
        const leaf = this.chooseSubtree(this.m_root, aMin, aMax, path);
        // Insert into leaf
        if (!leaf.IsFull()) {
            const slot = leaf.count;
            leaf.SetChildBounds(slot, aMin, aMax);
            leaf.SetInsertBounds(slot, aMin, aMax);
            leaf.data[slot] = aData;
            leaf.count++;
            this.adjustPath(path, leaf);
        }
        else {
            this.overflowTreatment(leaf, aMin, aMax, aData, path, reinsertedLevels);
        }
    }
    /**
     * R*-tree ChooseSubtree.
     *
     * At the level just above leaves (level==1): minimize overlap increase.
     * At higher levels: minimize area increase, tie-break by smallest area.
     */
    chooseSubtree(aNode, aMin, aMax, aPath) {
        aPath.length = 0;
        let node = aNode;
        while (node.IsInternal()) {
            aPath.push(node);
            if (node.level === 1) {
                // At the level just above leaves: minimize overlap increase
                let bestIdx = 0;
                let bestOverlapInc = INT64_MAX;
                let bestAreaInc = INT64_MAX;
                let bestArea = INT64_MAX;
                for (let i = 0; i < node.count; ++i) {
                    const overlapBefore = this.computeOverlap(node, i);
                    const overlapAfter = this.computeOverlapEnlarged(node, i, aMin, aMax);
                    const overlapInc = overlapAfter - overlapBefore;
                    const areaInc = node.ChildEnlargement(i, aMin, aMax);
                    const area = node.ChildArea(i);
                    if (overlapInc < bestOverlapInc ||
                        (overlapInc === bestOverlapInc && areaInc < bestAreaInc) ||
                        (overlapInc === bestOverlapInc &&
                            areaInc === bestAreaInc &&
                            area < bestArea)) {
                        bestIdx = i;
                        bestOverlapInc = overlapInc;
                        bestAreaInc = areaInc;
                        bestArea = area;
                    }
                }
                node = node.children[bestIdx];
            }
            else {
                // Higher levels: minimize area increase, tie-break by smallest area
                let bestIdx = 0;
                let bestAreaInc = INT64_MAX;
                let bestArea = INT64_MAX;
                for (let i = 0; i < node.count; ++i) {
                    const areaInc = node.ChildEnlargement(i, aMin, aMax);
                    const area = node.ChildArea(i);
                    if (areaInc < bestAreaInc || (areaInc === bestAreaInc && area < bestArea)) {
                        bestIdx = i;
                        bestAreaInc = areaInc;
                        bestArea = area;
                    }
                }
                node = node.children[bestIdx];
            }
        }
        return node;
    }
    /**
     * Handle overflow: forced reinsert or split.
     */
    overflowTreatment(aNode, aMin, aMax, aData, aPath, reinsertedLevels) {
        const level = aNode.level;
        // Guard against UB from shifting by >= 32 (see C++ comment).
        if (level >= 32) {
            this.splitNode(aNode, aMin, aMax, aData, aPath, reinsertedLevels);
            return;
        }
        const levelMask = 1 << level;
        if (!(reinsertedLevels.value & levelMask)) {
            reinsertedLevels.value |= levelMask;
            this.forcedReinsert(aNode, aMin, aMax, aData, aPath, reinsertedLevels);
        }
        else {
            this.splitNode(aNode, aMin, aMax, aData, aPath, reinsertedLevels);
        }
    }
    /**
     * R*-tree forced reinsert.
     *
     * Temporarily adds the new entry, then removes the REINSERT_COUNT entries
     * farthest from the node center, and reinserts them.
     */
    forcedReinsert(aNode, aMin, aMax, aData, aPath, reinsertedLevels) {
        const totalEntries = aNode.count + 1;
        const entries = new Array(totalEntries);
        // Compute node center
        const nodeMin = new Array(this.NUMDIMS);
        const nodeMax = new Array(this.NUMDIMS);
        aNode.ComputeEnclosingBounds(nodeMin, nodeMax);
        const center = new Array(this.NUMDIMS);
        for (let d = 0; d < this.NUMDIMS; ++d) {
            center[d] = (nodeMin[d] + nodeMax[d]) / 2.0;
        }
        // Gather existing entries
        for (let i = 0; i < aNode.count; ++i) {
            const e = {
                min: new Array(this.NUMDIMS),
                max: new Array(this.NUMDIMS),
                insertMin: new Array(this.NUMDIMS),
                insertMax: new Array(this.NUMDIMS),
                data: aData,
                child: null,
                distSq: 0,
            };
            entries[i] = e;
            aNode.GetChildBounds(i, e.min, e.max);
            if (aNode.IsLeaf()) {
                aNode.GetInsertBounds(i, e.insertMin, e.insertMax);
                e.data = aNode.data[i];
                e.child = null;
            }
            else {
                e.child = aNode.children[i];
            }
            // Distance from entry center to node center
            let distSq = 0;
            for (let d = 0; d < this.NUMDIMS; ++d) {
                const entryCenter = (e.min[d] + e.max[d]) / 2.0;
                const diff = entryCenter - center[d];
                distSq += diff * diff;
            }
            e.distSq = distSq;
        }
        // Add the new entry
        const newEntry = {
            min: new Array(this.NUMDIMS),
            max: new Array(this.NUMDIMS),
            insertMin: new Array(this.NUMDIMS),
            insertMax: new Array(this.NUMDIMS),
            data: aData,
            child: null,
            distSq: 0,
        };
        entries[aNode.count] = newEntry;
        for (let d = 0; d < this.NUMDIMS; ++d) {
            newEntry.min[d] = aMin[d];
            newEntry.max[d] = aMax[d];
            newEntry.insertMin[d] = aMin[d];
            newEntry.insertMax[d] = aMax[d];
        }
        newEntry.data = aData;
        newEntry.child = null;
        let distSq = 0;
        for (let d = 0; d < this.NUMDIMS; ++d) {
            const entryCenter = (aMin[d] + aMax[d]) / 2.0;
            const diff = entryCenter - center[d];
            distSq += diff * diff;
        }
        newEntry.distSq = distSq;
        // Sort by distance descending to find the farthest
        entries.sort((a, b) => b.distSq - a.distSq);
        // Keep close entries in the node, reinsert far ones
        const reinsertCount = Math.min(this.REINSERT_COUNT, totalEntries - this.MINNODES);
        if (reinsertCount <= 0) {
            // Can't reinsert without underflow, fall back to split
            this.splitNode(aNode, aMin, aMax, aData, aPath, reinsertedLevels);
            return;
        }
        // Rebuild the node with the close entries
        aNode.count = 0;
        for (let i = reinsertCount; i < totalEntries; ++i) {
            const slot = aNode.count;
            aNode.SetChildBounds(slot, entries[i].min, entries[i].max);
            if (aNode.IsLeaf()) {
                aNode.SetInsertBounds(slot, entries[i].insertMin, entries[i].insertMax);
                aNode.data[slot] = entries[i].data;
            }
            else {
                aNode.children[slot] = entries[i].child;
            }
            aNode.count++;
        }
        this.adjustPath(aPath, aNode);
        // Reinsert the far entries
        for (let i = 0; i < reinsertCount; ++i) {
            if (aNode.IsLeaf()) {
                this.insertImpl(entries[i].insertMin, entries[i].insertMax, entries[i].data, reinsertedLevels);
            }
            else {
                this.reinsertNode(entries[i].child, entries[i].min, entries[i].max, aNode.level - 1, reinsertedLevels);
            }
        }
    }
    /**
     * Reinsert an internal node's child at its correct level.
     */
    reinsertNode(aChild, aMin, aMax, aLevel, reinsertedLevels) {
        // Find a node at the correct level
        const path = [];
        const target = this.chooseSubtreeAtLevel(this.m_root, aMin, aMax, aLevel + 1, path);
        if (!target.IsFull()) {
            const slot = target.count;
            target.SetChildBounds(slot, aMin, aMax);
            target.children[slot] = aChild;
            target.count++;
            this.adjustPath(path, target);
        }
        else {
            this.splitNodeInternal(target, aMin, aMax, aChild, path, reinsertedLevels);
        }
    }
    /**
     * ChooseSubtree targeting a specific level.
     */
    chooseSubtreeAtLevel(aNode, aMin, aMax, aTargetLevel, aPath) {
        aPath.length = 0;
        let node = aNode;
        while (node.level > aTargetLevel) {
            aPath.push(node);
            let bestIdx = 0;
            let bestAreaInc = INT64_MAX;
            let bestArea = INT64_MAX;
            for (let i = 0; i < node.count; ++i) {
                const areaInc = node.ChildEnlargement(i, aMin, aMax);
                const area = node.ChildArea(i);
                if (areaInc < bestAreaInc || (areaInc === bestAreaInc && area < bestArea)) {
                    bestIdx = i;
                    bestAreaInc = areaInc;
                    bestArea = area;
                }
            }
            node = node.children[bestIdx];
        }
        return node;
    }
    // Entry type used by both leaf and internal node split algorithms
    makeSplitEntry() {
        return {
            min: new Array(this.NUMDIMS),
            max: new Array(this.NUMDIMS),
            insertMin: new Array(this.NUMDIMS),
            insertMax: new Array(this.NUMDIMS),
            data: undefined,
            child: null,
        };
    }
    /**
     * R*-tree split (leaf).
     *
     * ChooseSplitAxis: for each axis, sort by min then max. Choose axis
     * minimizing sum of perimeters across all valid distributions.
     *
     * ChooseSplitIndex: along chosen axis, choose distribution minimizing overlap.
     */
    splitNode(aNode, aMin, aMax, aData, aPath, reinsertedLevels) {
        // Collect all entries including the overflow entry
        const totalEntries = aNode.count + 1;
        const entries = new Array(totalEntries);
        for (let i = 0; i < aNode.count; ++i) {
            const e = this.makeSplitEntry();
            entries[i] = e;
            aNode.GetChildBounds(i, e.min, e.max);
            if (aNode.IsLeaf()) {
                aNode.GetInsertBounds(i, e.insertMin, e.insertMax);
                e.data = aNode.data[i];
                e.child = null;
            }
            else {
                e.child = aNode.children[i];
            }
        }
        // The overflow entry
        const over = this.makeSplitEntry();
        entries[aNode.count] = over;
        for (let d = 0; d < this.NUMDIMS; ++d) {
            over.min[d] = aMin[d];
            over.max[d] = aMax[d];
            over.insertMin[d] = aMin[d];
            over.insertMax[d] = aMax[d];
        }
        over.data = aData;
        over.child = null;
        // ChooseSplitAxis: minimize sum of perimeters
        let bestAxis = 0;
        let bestPerimeterSum = INT64_MAX;
        for (let axis = 0; axis < this.NUMDIMS; ++axis) {
            let perimeterSum = 0;
            // Sort by min bound on this axis
            entries.sort((a, b) => {
                return a.min[axis] < b.min[axis]
                    || (a.min[axis] === b.min[axis] && a.max[axis] < b.max[axis])
                    ? -1
                    : 1;
            });
            perimeterSum += this.computeSplitPerimeters(entries, totalEntries);
            // Sort by max bound on this axis
            entries.sort((a, b) => {
                return a.max[axis] < b.max[axis]
                    || (a.max[axis] === b.max[axis] && a.min[axis] < b.min[axis])
                    ? -1
                    : 1;
            });
            perimeterSum += this.computeSplitPerimeters(entries, totalEntries);
            if (perimeterSum < bestPerimeterSum) {
                bestPerimeterSum = perimeterSum;
                bestAxis = axis;
            }
        }
        // ChooseSplitIndex along bestAxis: minimize overlap
        // Re-sort by min on best axis
        entries.sort((a, b) => {
            return a.min[bestAxis] < b.min[bestAxis]
                || (a.min[bestAxis] === b.min[bestAxis] && a.max[bestAxis] < b.max[bestAxis])
                ? -1
                : 1;
        });
        let bestSplit = this.findBestSplitIndex(entries, totalEntries);
        // Also try sorting by max
        const entriesByMax = entries.slice();
        entriesByMax.sort((a, b) => {
            return a.max[bestAxis] < b.max[bestAxis]
                || (a.max[bestAxis] === b.max[bestAxis] && a.min[bestAxis] < b.min[bestAxis])
                ? -1
                : 1;
        });
        const bestSplitMax = this.findBestSplitIndex(entriesByMax, totalEntries);
        const overlapMin = this.computeSplitOverlap(entries, bestSplit, totalEntries);
        const overlapMax = this.computeSplitOverlap(entriesByMax, bestSplitMax, totalEntries);
        if (overlapMax < overlapMin) {
            entries.splice(0, entries.length, ...entriesByMax);
            bestSplit = bestSplitMax;
        }
        // Create new sibling node
        const sibling = this.allocNode();
        sibling.level = aNode.level;
        // Distribute entries
        aNode.count = 0;
        for (let i = 0; i < bestSplit; ++i) {
            const slot = aNode.count;
            aNode.SetChildBounds(slot, entries[i].min, entries[i].max);
            if (aNode.IsLeaf()) {
                aNode.SetInsertBounds(slot, entries[i].insertMin, entries[i].insertMax);
                aNode.data[slot] = entries[i].data;
            }
            else {
                aNode.children[slot] = entries[i].child;
            }
            aNode.count++;
        }
        for (let i = bestSplit; i < totalEntries; ++i) {
            const slot = sibling.count;
            sibling.SetChildBounds(slot, entries[i].min, entries[i].max);
            if (aNode.IsLeaf()) {
                sibling.SetInsertBounds(slot, entries[i].insertMin, entries[i].insertMax);
                sibling.data[slot] = entries[i].data;
            }
            else {
                sibling.children[slot] = entries[i].child;
            }
            sibling.count++;
        }
        // Propagate the split upward
        const sibMin = new Array(this.NUMDIMS);
        const sibMax = new Array(this.NUMDIMS);
        sibling.ComputeEnclosingBounds(sibMin, sibMax);
        if (aPath.length === 0) {
            // Splitting the root: create new root
            const newRoot = this.allocNode();
            newRoot.level = this.m_root.level + 1;
            const nodeMin = new Array(this.NUMDIMS);
            const nodeMax = new Array(this.NUMDIMS);
            aNode.ComputeEnclosingBounds(nodeMin, nodeMax);
            newRoot.SetChildBounds(0, nodeMin, nodeMax);
            newRoot.children[0] = aNode;
            newRoot.SetChildBounds(1, sibMin, sibMax);
            newRoot.children[1] = sibling;
            newRoot.count = 2;
            this.m_root = newRoot;
        }
        else {
            const parent = aPath[aPath.length - 1];
            // Update the existing child's bbox in parent
            const childSlot = this.findChildSlot(parent, aNode);
            if (childSlot >= 0) {
                const nodeMin = new Array(this.NUMDIMS);
                const nodeMax = new Array(this.NUMDIMS);
                aNode.ComputeEnclosingBounds(nodeMin, nodeMax);
                parent.SetChildBounds(childSlot, nodeMin, nodeMax);
            }
            // Insert sibling into parent
            if (!parent.IsFull()) {
                const slot = parent.count;
                parent.SetChildBounds(slot, sibMin, sibMax);
                parent.children[slot] = sibling;
                parent.count++;
                aPath.pop();
                this.adjustPath(aPath, parent);
            }
            else {
                aPath.pop();
                this.splitNodeInternal(parent, sibMin, sibMax, sibling, aPath, reinsertedLevels);
            }
        }
    }
    /**
     * Split an internal node to insert a new child.
     */
    splitNodeInternal(aNode, aMin, aMax, aChild, aPath, reinsertedLevels) {
        const totalEntries = aNode.count + 1;
        const entries = new Array(totalEntries);
        for (let i = 0; i < aNode.count; ++i) {
            const e = this.makeSplitEntry();
            entries[i] = e;
            aNode.GetChildBounds(i, e.min, e.max);
            e.child = aNode.children[i];
        }
        const over = this.makeSplitEntry();
        entries[aNode.count] = over;
        for (let d = 0; d < this.NUMDIMS; ++d) {
            over.min[d] = aMin[d];
            over.max[d] = aMax[d];
        }
        over.child = aChild;
        // Choose best axis
        let bestAxis = 0;
        let bestPerimeterSum = INT64_MAX;
        for (let axis = 0; axis < this.NUMDIMS; ++axis) {
            entries.sort((a, b) => (a.min[axis] < b.min[axis] ? -1 : 1));
            const perimSum = this.computeSplitPerimeters(entries, totalEntries);
            if (perimSum < bestPerimeterSum) {
                bestPerimeterSum = perimSum;
                bestAxis = axis;
            }
        }
        // Re-sort on best axis, find best split
        entries.sort((a, b) => (a.min[bestAxis] < b.min[bestAxis] ? -1 : 1));
        const bestSplit = this.findBestSplitIndex(entries, totalEntries);
        // Create sibling
        const sibling = this.allocNode();
        sibling.level = aNode.level;
        aNode.count = 0;
        for (let i = 0; i < bestSplit; ++i) {
            const slot = aNode.count;
            aNode.SetChildBounds(slot, entries[i].min, entries[i].max);
            aNode.children[slot] = entries[i].child;
            aNode.count++;
        }
        for (let i = bestSplit; i < totalEntries; ++i) {
            const slot = sibling.count;
            sibling.SetChildBounds(slot, entries[i].min, entries[i].max);
            sibling.children[slot] = entries[i].child;
            sibling.count++;
        }
        const sibMin = new Array(this.NUMDIMS);
        const sibMax = new Array(this.NUMDIMS);
        sibling.ComputeEnclosingBounds(sibMin, sibMax);
        if (aPath.length === 0) {
            const newRoot = this.allocNode();
            newRoot.level = this.m_root.level + 1;
            const nodeMin = new Array(this.NUMDIMS);
            const nodeMax = new Array(this.NUMDIMS);
            aNode.ComputeEnclosingBounds(nodeMin, nodeMax);
            newRoot.SetChildBounds(0, nodeMin, nodeMax);
            newRoot.children[0] = aNode;
            newRoot.SetChildBounds(1, sibMin, sibMax);
            newRoot.children[1] = sibling;
            newRoot.count = 2;
            this.m_root = newRoot;
        }
        else {
            const parent = aPath[aPath.length - 1];
            const childSlot = this.findChildSlot(parent, aNode);
            if (childSlot >= 0) {
                const nodeMin = new Array(this.NUMDIMS);
                const nodeMax = new Array(this.NUMDIMS);
                aNode.ComputeEnclosingBounds(nodeMin, nodeMax);
                parent.SetChildBounds(childSlot, nodeMin, nodeMax);
            }
            if (!parent.IsFull()) {
                const slot = parent.count;
                parent.SetChildBounds(slot, sibMin, sibMax);
                parent.children[slot] = sibling;
                parent.count++;
                aPath.pop();
                this.adjustPath(aPath, parent);
            }
            else {
                aPath.pop();
                this.splitNodeInternal(parent, sibMin, sibMax, sibling, aPath, reinsertedLevels);
            }
        }
    }
    /**
     * Compute sum of perimeters for all valid split distributions.
     */
    computeSplitPerimeters(entries, aTotalEntries) {
        let sum = 0;
        for (let k = this.MINNODES; k <= aTotalEntries - this.MINNODES; ++k) {
            // Group 1: entries [0, k); Group 2: entries [k, totalEntries)
            for (let grp = 0; grp < 2; ++grp) {
                const start = grp === 0 ? 0 : k;
                const end = grp === 0 ? k : aTotalEntries;
                let perimeter = 0;
                for (let d = 0; d < this.NUMDIMS; ++d) {
                    let mn = INT64_MAX;
                    let mx = INT64_MIN;
                    for (let i = start; i < end; ++i) {
                        if (entries[i].min[d] < mn) {
                            mn = entries[i].min[d];
                        }
                        if (entries[i].max[d] > mx) {
                            mx = entries[i].max[d];
                        }
                    }
                    perimeter += mx - mn;
                }
                sum += 2 * perimeter;
            }
        }
        return sum;
    }
    /**
     * Find the split index that minimizes overlap between the two groups.
     */
    findBestSplitIndex(entries, aTotalEntries) {
        let bestSplit = this.MINNODES;
        let bestOverlap = INT64_MAX;
        let bestAreaSum = INT64_MAX;
        for (let k = this.MINNODES; k <= aTotalEntries - this.MINNODES; ++k) {
            const overlap = this.computeSplitOverlap(entries, k, aTotalEntries);
            // Compute area sum for tie-breaking
            let areaSum = 0;
            for (let grp = 0; grp < 2; ++grp) {
                const start = grp === 0 ? 0 : k;
                const end = grp === 0 ? k : aTotalEntries;
                let area = 1;
                for (let d = 0; d < this.NUMDIMS; ++d) {
                    let mn = INT64_MAX;
                    let mx = INT64_MIN;
                    for (let i = start; i < end; ++i) {
                        if (entries[i].min[d] < mn) {
                            mn = entries[i].min[d];
                        }
                        if (entries[i].max[d] > mx) {
                            mx = entries[i].max[d];
                        }
                    }
                    area *= mx - mn;
                }
                areaSum += area;
            }
            if (overlap < bestOverlap || (overlap === bestOverlap && areaSum < bestAreaSum)) {
                bestSplit = k;
                bestOverlap = overlap;
                bestAreaSum = areaSum;
            }
        }
        return bestSplit;
    }
    /**
     * Compute the overlap area between two split groups.
     */
    computeSplitOverlap(entries, aSplitIdx, aTotalEntries) {
        const g1Min = new Array(this.NUMDIMS).fill(INT64_MAX);
        const g1Max = new Array(this.NUMDIMS).fill(INT64_MIN);
        const g2Min = new Array(this.NUMDIMS).fill(INT64_MAX);
        const g2Max = new Array(this.NUMDIMS).fill(INT64_MIN);
        for (let i = 0; i < aSplitIdx; ++i) {
            for (let d = 0; d < this.NUMDIMS; ++d) {
                if (entries[i].min[d] < g1Min[d]) {
                    g1Min[d] = entries[i].min[d];
                }
                if (entries[i].max[d] > g1Max[d]) {
                    g1Max[d] = entries[i].max[d];
                }
            }
        }
        for (let i = aSplitIdx; i < aTotalEntries; ++i) {
            for (let d = 0; d < this.NUMDIMS; ++d) {
                if (entries[i].min[d] < g2Min[d]) {
                    g2Min[d] = entries[i].min[d];
                }
                if (entries[i].max[d] > g2Max[d]) {
                    g2Max[d] = entries[i].max[d];
                }
            }
        }
        // Compute overlap volume
        let overlap = 1;
        for (let d = 0; d < this.NUMDIMS; ++d) {
            const lo = Math.max(g1Min[d], g2Min[d]);
            const hi = Math.min(g1Max[d], g2Max[d]);
            if (lo >= hi) {
                return 0;
            }
            overlap *= hi - lo;
        }
        return overlap;
    }
    /**
     * Compute total overlap of child i with all other children in the node.
     */
    computeOverlap(aNode, aIdx) {
        let total = 0;
        const iMin = new Array(this.NUMDIMS);
        const iMax = new Array(this.NUMDIMS);
        aNode.GetChildBounds(aIdx, iMin, iMax);
        for (let j = 0; j < aNode.count; ++j) {
            if (j === aIdx) {
                continue;
            }
            total += aNode.ChildOverlapArea(j, iMin, iMax);
        }
        return total;
    }
    /**
     * Compute total overlap of child i (enlarged to include query box) with
     * other children.
     */
    computeOverlapEnlarged(aNode, aIdx, aMin, aMax) {
        const enlargedMin = new Array(this.NUMDIMS);
        const enlargedMax = new Array(this.NUMDIMS);
        aNode.GetChildBounds(aIdx, enlargedMin, enlargedMax);
        for (let d = 0; d < this.NUMDIMS; ++d) {
            if (aMin[d] < enlargedMin[d]) {
                enlargedMin[d] = aMin[d];
            }
            if (aMax[d] > enlargedMax[d]) {
                enlargedMax[d] = aMax[d];
            }
        }
        let total = 0;
        for (let j = 0; j < aNode.count; ++j) {
            if (j === aIdx) {
                continue;
            }
            total += aNode.ChildOverlapArea(j, enlargedMin, enlargedMax);
        }
        return total;
    }
    /**
     * Adjust bounding boxes for all nodes in the path (root to leaf).
     */
    adjustPath(aPath, aBottomChild = null) {
        let childToUpdate = aBottomChild;
        for (let i = aPath.length - 1; i >= 0; --i) {
            const parent = aPath[i];
            if (childToUpdate) {
                const slot = this.findChildSlot(parent, childToUpdate);
                if (slot >= 0) {
                    const childMin = new Array(this.NUMDIMS);
                    const childMax = new Array(this.NUMDIMS);
                    childToUpdate.ComputeEnclosingBounds(childMin, childMax);
                    parent.SetChildBounds(slot, childMin, childMax);
                }
            }
            childToUpdate = parent;
        }
    }
    findChildSlot(aParent, aChild) {
        for (let i = 0; i < aParent.count; ++i) {
            if (aParent.children[i] === aChild) {
                return i;
            }
        }
        return -1;
    }
    /**
     * Remove an item from the tree, collecting underflowing nodes for reinsertion.
     */
    removeImpl(aNode, aMin, aMax, aData, aReinsertList) {
        if (aNode.IsLeaf()) {
            for (let i = 0; i < aNode.count; ++i) {
                if (aNode.data[i] === aData && aNode.ChildOverlaps(i, aMin, aMax)) {
                    aNode.RemoveChild(i);
                    return true;
                }
            }
            return false;
        }
        // Internal node: recurse into children whose bbox overlaps the query
        for (let i = 0; i < aNode.count; ++i) {
            if (!aNode.ChildOverlaps(i, aMin, aMax)) {
                continue;
            }
            const child = aNode.children[i];
            if (this.removeImpl(child, aMin, aMax, aData, aReinsertList)) {
                // Update child's bbox in parent
                if (child.count > 0) {
                    const childMin = new Array(this.NUMDIMS);
                    const childMax = new Array(this.NUMDIMS);
                    child.ComputeEnclosingBounds(childMin, childMax);
                    aNode.SetChildBounds(i, childMin, childMax);
                    // Check for underflow
                    if (child.count < this.MINNODES && aNode !== this.m_root) {
                        aReinsertList.push(child);
                        aNode.RemoveChild(i);
                    }
                }
                else {
                    this.freeNode(child);
                    aNode.RemoveChild(i);
                }
                return true;
            }
        }
        return false;
    }
    /**
     * Reinsert all entries from orphaned underflowing nodes.
     */
    reinsertOrphans(aReinsertList) {
        for (const orphan of aReinsertList) {
            if (orphan.IsLeaf()) {
                for (let i = 0; i < orphan.count; ++i) {
                    const mn = new Array(this.NUMDIMS);
                    const mx = new Array(this.NUMDIMS);
                    orphan.GetInsertBounds(i, mn, mx);
                    const reinsertedLevels = { value: 0 };
                    this.insertImpl(mn, mx, orphan.data[i], reinsertedLevels);
                }
            }
            else {
                for (let i = 0; i < orphan.count; ++i) {
                    const mn = new Array(this.NUMDIMS);
                    const mx = new Array(this.NUMDIMS);
                    orphan.GetChildBounds(i, mn, mx);
                    const reinsertedLevels = { value: 0 };
                    this.reinsertNode(orphan.children[i], mn, mx, orphan.level - 1, reinsertedLevels);
                }
            }
            this.freeNode(orphan);
        }
    }
    /**
     * If the root has only one child, replace it with that child.
     */
    condenseRoot() {
        while (this.m_root && this.m_root.IsInternal() && this.m_root.count === 1) {
            const oldRoot = this.m_root;
            this.m_root = this.m_root.children[0];
            this.freeNode(oldRoot);
        }
        if (this.m_root && this.m_root.count === 0) {
            this.freeNode(this.m_root);
            this.m_root = null;
        }
    }
    /**
     * Recursive search. Returns true if search should continue, false if
     * visitor stopped early.
     */
    searchImpl(aNode, aMin, aMax, aVisitor, aFound) {
        let mask = aNode.ChildOverlapMask(aMin, aMax);
        if (aNode.IsLeaf()) {
            while (mask) {
                const i = countrZero(mask);
                mask &= mask - 1;
                aFound.value++;
                if (!aVisitor(aNode.data[i])) {
                    return false;
                }
            }
        }
        else {
            while (mask) {
                const i = countrZero(mask);
                mask &= mask - 1;
                if (!this.searchImpl(aNode.children[i], aMin, aMax, aVisitor, aFound)) {
                    return false;
                }
            }
        }
        return true;
    }
}
/** Mirrors std::countr_zero for 32-bit masks (fanout <= 16 here). */
function countrZero(mask) {
    let c = 0;
    while ((mask & 1) === 0) {
        mask >>>= 1;
        c++;
    }
    return c;
}
