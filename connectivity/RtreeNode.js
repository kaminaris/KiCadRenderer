/*
 * Ported from KiCad kimath/include/geometry/rtree/rtree_node.h.
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
 *  - The C++ uses a SoA layout with SIMD-accelerated ChildOverlapMask and a
 *    slab allocator. Those are micro-optimizations that don't translate to
 *    TypeScript; the scalar loops below implement the identical arithmetic.
 *  - The slab allocator (SLAB_ALLOCATOR) is dropped — plain `new` and GC.
 */
export const INT64_MAX = Number.MAX_SAFE_INTEGER;
export const INT64_MIN = Number.MIN_SAFE_INTEGER;
/**
 * Node of the dynamic R*-tree. Mirrors RTREE_NODE in rtree_node.h.
 *
 * @param DATATYPE  Type of data stored in leaf nodes
 * @param NUMDIMS   Number of dimensions (3 for the connectivity tree: layer, x, y)
 * @param MAXNODES  Maximum children per node (fanout)
 */
export class RTREE_NODE {
    NUMDIMS;
    MAXNODES;
    static MINNODES_FROM = (MAXNODES) => Math.floor((MAXNODES * 2) / 5); // ~40%, R*-tree convention
    count = 0; // Number of valid children
    level = 0; // 0 = leaf, higher = internal
    // SoA bounding boxes: bounds[axis*2+side][slot]
    // side 0 = min, side 1 = max
    bounds;
    insertBounds;
    // Leaf node data / internal node children (only one used, per IsLeaf)
    data;
    children;
    constructor(NUMDIMS, MAXNODES) {
        this.NUMDIMS = NUMDIMS;
        this.MAXNODES = MAXNODES;
        this.bounds = new Array(NUMDIMS * 2);
        this.insertBounds = new Array(NUMDIMS * 2);
        for (let d = 0; d < NUMDIMS * 2; d++) {
            this.bounds[d] = new Array(MAXNODES).fill(0);
            this.insertBounds[d] = new Array(MAXNODES).fill(0);
        }
        this.data = new Array(MAXNODES);
        this.children = new Array(MAXNODES).fill(null);
    }
    IsLeaf() {
        return this.level === 0;
    }
    IsInternal() {
        return this.level > 0;
    }
    IsFull() {
        return this.count >= this.MAXNODES;
    }
    IsUnderflow() {
        return this.count < RTREE_NODE.MINNODES_FROM(this.MAXNODES);
    }
    /**
     * Compute the bounding box that encloses all children in this node.
     */
    ComputeEnclosingBounds(aMin, aMax) {
        for (let d = 0; d < this.NUMDIMS; ++d) {
            aMin[d] = INT64_MAX;
            aMax[d] = INT64_MIN;
        }
        for (let i = 0; i < this.count; ++i) {
            for (let d = 0; d < this.NUMDIMS; ++d) {
                if (this.bounds[d * 2][i] < aMin[d]) {
                    aMin[d] = this.bounds[d * 2][i];
                }
                if (this.bounds[d * 2 + 1][i] > aMax[d]) {
                    aMax[d] = this.bounds[d * 2 + 1][i];
                }
            }
        }
    }
    /**
     * Compute the area (or volume for 3D) of child slot i's bounding box.
     */
    ChildArea(i) {
        let area = 1;
        for (let d = 0; d < this.NUMDIMS; ++d) {
            area *= this.bounds[d * 2 + 1][i] - this.bounds[d * 2][i];
        }
        return area;
    }
    /**
     * Test whether child slot i's bounding box overlaps with the given query box.
     */
    ChildOverlaps(i, aMin, aMax) {
        for (let d = 0; d < this.NUMDIMS; ++d) {
            if (this.bounds[d * 2][i] > aMax[d] || this.bounds[d * 2 + 1][i] < aMin[d]) {
                return false;
            }
        }
        return true;
    }
    /**
     * Bitmask of children whose bounding boxes overlap the query rectangle.
     * Bit i is set if child i overlaps. (Scalar port of the SIMD
     * ChildOverlapMask; MAXNODES <= 16 so the mask fits in 16 bits.)
     */
    ChildOverlapMask(aMin, aMax) {
        let mask = 0;
        for (let i = 0; i < this.count; ++i) {
            if (this.ChildOverlaps(i, aMin, aMax)) {
                mask |= 1 << i;
            }
        }
        return mask;
    }
    /**
     * Compute the overlap area between child slot i and the given box.
     */
    ChildOverlapArea(i, aMin, aMax) {
        let overlap = 1;
        for (let d = 0; d < this.NUMDIMS; ++d) {
            const lo = Math.max(this.bounds[d * 2][i], aMin[d]);
            const hi = Math.min(this.bounds[d * 2 + 1][i], aMax[d]);
            if (lo > hi) {
                return 0;
            }
            overlap *= hi - lo;
        }
        return overlap;
    }
    /**
     * Compute how much child slot i's area would increase if it were enlarged
     * to include the given bounding box.
     */
    ChildEnlargement(i, aMin, aMax) {
        const originalArea = this.ChildArea(i);
        let enlargedArea = 1;
        for (let d = 0; d < this.NUMDIMS; ++d) {
            const lo = Math.min(this.bounds[d * 2][i], aMin[d]);
            const hi = Math.max(this.bounds[d * 2 + 1][i], aMax[d]);
            enlargedArea *= hi - lo;
        }
        return enlargedArea - originalArea;
    }
    /**
     * Compute the perimeter (or margin for 3D) of child slot i's bounding box.
     * Used for split axis selection in R*-tree.
     */
    ChildPerimeter(i) {
        let perimeter = 0;
        for (let d = 0; d < this.NUMDIMS; ++d) {
            perimeter += this.bounds[d * 2 + 1][i] - this.bounds[d * 2][i];
        }
        return 2 * perimeter;
    }
    /**
     * Set the bounding box for child slot i.
     */
    SetChildBounds(i, aMin, aMax) {
        for (let d = 0; d < this.NUMDIMS; ++d) {
            this.bounds[d * 2][i] = aMin[d];
            this.bounds[d * 2 + 1][i] = aMax[d];
        }
    }
    /**
     * Get the bounding box for child slot i.
     */
    GetChildBounds(i, aMin, aMax) {
        for (let d = 0; d < this.NUMDIMS; ++d) {
            aMin[d] = this.bounds[d * 2][i];
            aMax[d] = this.bounds[d * 2 + 1][i];
        }
    }
    /**
     * Store the insertion bounding box for leaf entry i.
     */
    SetInsertBounds(i, aMin, aMax) {
        for (let d = 0; d < this.NUMDIMS; ++d) {
            this.insertBounds[d * 2][i] = aMin[d];
            this.insertBounds[d * 2 + 1][i] = aMax[d];
        }
    }
    /**
     * Get the stored insertion bounding box for leaf entry i.
     */
    GetInsertBounds(i, aMin, aMax) {
        for (let d = 0; d < this.NUMDIMS; ++d) {
            aMin[d] = this.insertBounds[d * 2][i];
            aMax[d] = this.insertBounds[d * 2 + 1][i];
        }
    }
    /**
     * Remove child at slot i by swapping with last entry.
     */
    RemoveChild(i) {
        const last = this.count - 1;
        if (i !== last) {
            for (let d = 0; d < this.NUMDIMS * 2; ++d) {
                this.bounds[d][i] = this.bounds[d][last];
                this.insertBounds[d][i] = this.insertBounds[d][last];
            }
            if (this.IsLeaf()) {
                this.data[i] = this.data[last];
            }
            else {
                this.children[i] = this.children[last];
            }
        }
        this.count--;
    }
}
