/*
 * DRC_RTREE — port of pcbnew/drc/drc_rtree.h's per-layer spatial index
 * (confirmed against the real source at apps/kicad/pcbnew/drc/drc_rtree.h,
 * 627 lines). Real KiCad backs this with a packed R-tree
 * (`KIRTREE::PACKED_RTREE`); this port backs it with the already-real
 * `SHAPE_INDEX_LIST` ported earlier for the connectivity/ratsnest work
 * (`geometry/ShapeIndexList.ts`, itself a direct port of KiCad's own
 * `SHAPE_INDEX_LIST` — the small "linear scan over cached bboxes"
 * alternative index real KiCad's OWN codebase uses in other DRC-adjacent
 * spots). Collision testing goes through `SHAPE.Collide()`, which is
 * `SHAPE_COLLISION` (`geometry/ShapeCollision.ts`) — also an existing
 * real port of `libs/kimath/src/geometry/shape_collision.cpp`. No new
 * geometry primitives were invented for this file; it is glue over
 * already-ported KiCad geometry code.
 *
 * Deliberately scoped down from the real class, each noted at point of
 * use:
 * - Only `Insert`/`Build`/`CheckColliding`/`QueryColliding` (the two
 *   BOARD_ITEM-pair overloads)/`OnLayer` are ported. `GetObjectsAt()`,
 *   the `Overlapping()` point/box queries, and `QueryCollidingPairs()`
 *   (the bulk ref-tree-vs-tree layer-pair sweep used by
 *   `drc_test_provider_copper_clearance.cpp`'s outer loop) are not
 *   ported yet — the first test provider built on this file constructs
 *   its own pairing loop instead (see that file's own header once
 *   landed).
 * - No hole-shape auto-insertion (`aItem->HasHole()` branch) — pad/via
 *   holes aren't modeled as a separate collidable shape by this port
 *   yet; a caller that needs hole clearance must `Insert()` a hole shape
 *   itself.
 * - `ATOMIC_TABLES`/table-cell parent-substitution isn't ported (no
 *   `PCB_TABLECELL_T` consumer exists yet).
 * - Sub-shape decomposition (`shape->GetIndexableSubshapes()`, used by
 *   real KiCad to index a `SHAPE_POLY_SET`'s individual triangles rather
 *   than the whole polyset as one bbox) isn't ported — a polyset is
 *   indexed as one item under its own overall bbox, which is correct but
 *   coarser-grained than real KiCad's per-triangle indexing.
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 */
import { BBox } from '../math/BBox';
import { SHAPE } from '../geometry/Shape';
import { SHAPE_INDEX_LIST } from '../geometry/ShapeIndexList';

export interface ItemWithShape<T> {
	parent: T;
	shape: SHAPE;
}

/**
 * Port of `DRC_RTREE` (see file header for exact scope). `T` is the
 * caller's board-item type (real KiCad: `BOARD_ITEM*`) — this class is
 * agnostic to it, matching the real class's own non-owning, generic
 * design.
 */
export class DrcRtree<T> {
	private tree = new Map<number, SHAPE_INDEX_LIST<ItemWithShape<T>>>();
	private count = 0;

	/** Port of `Insert()` — the single-shape form (real KiCad's
	 *  sub-shape decomposition isn't ported, see file header, so this
	 *  always inserts exactly one entry per call). */
	insert(item: T, layer: number, shape: SHAPE, worstClearance = 0): void {
		let list = this.tree.get(layer);
		if (!list) this.tree.set(layer, list = new SHAPE_INDEX_LIST());

		const bbox = shape.BBox(worstClearance);
		list.Add(bbox, { parent: item, shape });
		this.count++;
	}

	/** Port of `Build()`. `SHAPE_INDEX_LIST` needs no bulk-build step (it's
	 *  a flat list, not a packed tree), so this is a no-op kept for parity
	 *  with real KiCad's Insert-then-Build contract (a caller ported from
	 *  the real algorithm can call it unconditionally without a
	 *  KiOnline-specific branch). */
	build(): void { /* no-op — see doc comment */ }

	clear(): void {
		this.tree.clear();
		this.count = 0;
	}

	size(): number { return this.count; }
	isEmpty(): boolean { return this.count === 0; }

	/** Port of `CheckColliding()` — true if `refShape` collides with
	 *  anything on `targetLayer` within `clearance`, optionally filtered. */
	checkColliding(refShape: SHAPE, targetLayer: number, clearance = 0, filter?: (item: T) => boolean): boolean {
		const list = this.tree.get(targetLayer);
		if (!list) return false;

		const box = refShape.BBox(clearance);
		let found = false;

		list.Query(box, 0, entry => {
			if (filter && !filter(entry.parent)) return true;
			if (refShape.Collide(entry.shape, clearance)) {
				found = true;
				return false;
			}
			return true;
		});

		return found;
	}

	/** Port of the `BOARD_ITEM*`-pair overload of `QueryColliding()` —
	 *  counts (and optionally visits) every distinct item on `targetLayer`
	 *  colliding with `refItem`'s shape, skipping `refItem` itself. */
	queryColliding(
		refItem: T, refShape: SHAPE, targetLayer: number,
		clearance = 0, filter?: (item: T) => boolean, visitor?: (item: T) => boolean
	): number {
		const list = this.tree.get(targetLayer);
		if (!list) return 0;

		const box = refShape.BBox(clearance);
		const collidingAlready = new Set<T>();
		let count = 0;

		list.Query(box, 0, entry => {
			if (entry.parent === refItem || collidingAlready.has(entry.parent)) return true;
			if (filter && !filter(entry.parent)) return true;

			if (refShape.Collide(entry.shape, clearance)) {
				collidingAlready.add(entry.parent);
				count++;
				if (visitor && !visitor(entry.parent)) return false;
			}
			return true;
		});

		return count;
	}

	/** Port of `OnLayer()` — every entry indexed on `layer`. */
	onLayer(layer: number): ItemWithShape<T>[] {
		const list = this.tree.get(layer);
		return list ? [...list] : [];
	}
}

/** Re-exported for callers that need the bbox type without importing
 *  `../math/BBox` directly. */
export type { BBox };
