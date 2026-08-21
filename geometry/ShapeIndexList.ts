/*
 * Ported from KiCad source:
 *   libs/kimath/include/geometry/shape_index_list.h
 *   libs/kimath/src/geometry/shape_index_list.cpp
 *
 * Copyright (C) 2013-2017 CERN
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * A list-based spatial index over SHAPEs (a reusable AABB list, the small
 * "linear scan with per-item bbox" alternative to the R-tree). Mirrors
 * KiCad's SHAPE_INDEX_LIST. Coordinates in mm.
 */

import { Vec2 } from '../math/Vec2';
import { BBox } from '../math/BBox';
import { SHAPE } from './Shape';

/**
 * A node in the list: a shape plus its cached bounding box.
 */
export interface SHAPE_INDEX_LIST_ENTRY<N> {
	bbox: BBox;
	shape: N;
}

/**
 * A templated list of shapes indexed by their bounding boxes for range
 * queries. Mirrors KiCad's SHAPE_INDEX_LIST<N>.
 */
export class SHAPE_INDEX_LIST<N> {
	private m_list: SHAPE_INDEX_LIST_ENTRY<N>[] = [];

	/** Number of items in the index. */
	Size(): number {
		return this.m_list.length;
	}

	IsEmpty(): boolean {
		return this.m_list.length === 0;
	}

	Clear(): void {
		this.m_list = [];
	}

	/** Adds a shape to the index (its bbox is captured now). */
	Add(aItem: N): void;
	Add(aBBox: BBox, aItem: N): void;
	Add(aBBoxOrItem: BBox | N, aItem?: N): void {
		if (aBBoxOrItem instanceof BBox && aItem !== undefined) {
			this.m_list.push({ bbox: aBBoxOrItem.copy(), shape: aItem });
		} else {
			const shape = aBBoxOrItem as N;
			const bbox = (shape as unknown as SHAPE).BBox ? (shape as unknown as SHAPE).BBox() : new BBox();
			this.m_list.push({ bbox, shape });
		}
	}

	/** Removes an item from the index (by reference). */
	Remove(aItem: N): boolean {
		const idx = this.m_list.findIndex(e => e.shape === aItem);
		if (idx >= 0) {
			this.m_list.splice(idx, 1);
			return true;
		}
		return false;
	}

	/** Returns the bounding box of the whole index (union of all item boxes). */
	BBox(): BBox {
		if (this.m_list.length === 0) {
			return new BBox();
		}
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const e of this.m_list) {
			minX = Math.min(minX, e.bbox.x);
			minY = Math.min(minY, e.bbox.y);
			maxX = Math.max(maxX, e.bbox.x2);
			maxY = Math.max(maxY, e.bbox.y2);
		}
		return BBox.fromPoints([new Vec2(minX, minY), new Vec2(maxX, maxY)]);
	}

	/** Returns the i-th entry's bounding box. */
	GetBBox(aIndex: number): BBox {
		return this.m_list[aIndex]!.bbox;
	}

	/** Returns the i-th item. */
	GetItem(aIndex: number): N {
		return this.m_list[aIndex]!.shape;
	}

	/**
	 * Runs `aCallback` for every item whose bounding box intersects the query
	 * box (grown by aClearance). Mirrors KiCad's Query( aBBox, aClearance,
	 * aVisitor ) — the visitor returns true to continue.
	 */
	Query(aBox: BBox, aClearance: number, aVisitor: (aItem: N) => boolean): void {
		for (const e of this.m_list) {
			if (boxesIntersect(e.bbox, aBox, aClearance)) {
				if (!aVisitor(e.shape)) {
					return;
				}
			}
		}
	}

	/**
	 * Runs `aCallback` for every item. Mirrors KiCad's Query( aClearance,
	 * aVisitor ) over all items.
	 */
	QueryAll(aVisitor: (aItem: N) => boolean): void {
		for (const e of this.m_list) {
			if (!aVisitor(e.shape)) {
				return;
			}
		}
	}

	/** Returns every item whose bbox intersects the box (within clearance). */
	QueryBox(aBox: BBox, aClearance = 0): N[] {
		const out: N[] = [];
		this.Query(aBox, aClearance, item => {
			out.push(item);
			return true;
		});
		return out;
	}

	[Symbol.iterator](): Iterator<N> {
		let i = 0;
		const list = this.m_list;
		return {
			next(): IteratorResult<N> {
				if (i < list.length) {
					return { value: list[i++]!.shape, done: false };
				}
				return { value: undefined as unknown as N, done: true };
			},
		};
	}
}

function boxesIntersect(a: BBox, b: BBox, clearance: number): boolean {
	return (
		a.x <= b.x2 + clearance &&
		b.x <= a.x2 + clearance &&
		a.y <= b.y2 + clearance &&
		b.y <= a.y2 + clearance
	);
}
