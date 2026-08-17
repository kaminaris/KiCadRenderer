import { PaintedShape, shapeContainsPoint } from './PaintedShape';

/** Structural minimum hitTest() needs — satisfied by both BoardPainter's
 * PaintedItem and SchematicPainter's SchPaintedItem without either
 * depending on the other or duplicating this function. */
export interface Hittable {
	shape: PaintedShape;
	bbox: { x: number; y: number; w: number; h: number };
}

/**
 * Geometric hit-testing against the source data — not pixels. See the
 * in-thread design discussion: picking by reading rendered pixels (color-ID
 * buffers + readPixels) is the other classic GPU-stall trap, and a flat
 * canvas genuinely can't answer "what's under the cursor" without either
 * reading pixels back or asking the data. This asks the data.
 *
 * bbox is a broad-phase filter only — the precise test is shape-aware
 * (shapeContainsPoint), which is what actually fixes diagonal tracks having
 * a huge false-positive click area covering their whole bounding box.
 *
 * Broad-phase is a linear scan for the spike — fine up to a few thousand
 * items; swap for a spatial index (grid/R-tree) if a real dense board
 * proves it's needed.
 *
 * `tolerance` (world units, default 0) is real KiCad's screen-pixel click
 * accuracy already converted to world units by the caller — see
 * shapeContainsPoint's doc comment. Inflating the bbox check by the same
 * amount is required, not just an optimization: without it, a click just
 * outside a thin unfilled shape's tight bbox (e.g. right at a rect's edge)
 * could get broad-phase-rejected before shapeContainsPoint ever runs, even
 * though the precise edge test would have accepted it.
 */
export function hitTest<T extends Hittable>(items: T[], worldX: number, worldY: number, tolerance = 0, isVisible?: (item: T) => boolean): T | null {
	// Iterate in reverse paint order so the most recently drawn (topmost)
	// item wins on overlap, matching normal 2D compositing expectations.
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i]!;
		if (isVisible && !isVisible(item)) {
			continue;
		}
		const { x, y, w, h } = item.bbox;
		if (worldX < x - tolerance || worldX > x + w + tolerance || worldY < y - tolerance || worldY > y + h + tolerance) {
			continue;
		}
		if (shapeContainsPoint(item.shape, worldX, worldY, tolerance)) {
			return item;
		}
	}
	return null;
}

/**
 * Sibling of hitTest that collects EVERY match instead of stopping at the
 * first — the raw candidate pool a caller reduces (see
 * KicadRenderSession.hitTestCandidatesAtScreen) before deciding whether a
 * click is unambiguous, needs a KiCad-style disambiguation popup, or misses
 * entirely. Still ordered topmost-first (reverse paint order), which the
 * caller can use as a stable tie-break.
 */
export function hitTestAll<T extends Hittable>(items: T[], worldX: number, worldY: number, tolerance = 0, isVisible?: (item: T) => boolean): T[] {
	const matches: T[] = [];
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i]!;
		if (isVisible && !isVisible(item)) {
			continue;
		}
		const { x, y, w, h } = item.bbox;
		if (worldX < x - tolerance || worldX > x + w + tolerance || worldY < y - tolerance || worldY > y + h + tolerance) {
			continue;
		}
		if (shapeContainsPoint(item.shape, worldX, worldY, tolerance)) {
			matches.push(item);
		}
	}
	return matches;
}
