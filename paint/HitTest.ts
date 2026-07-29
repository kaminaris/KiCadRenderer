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
 */
export function hitTest<T extends Hittable>(items: T[], worldX: number, worldY: number): T | null {
	// Iterate in reverse paint order so the most recently drawn (topmost)
	// item wins on overlap, matching normal 2D compositing expectations.
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i]!;
		const { x, y, w, h } = item.bbox;
		if (worldX < x || worldX > x + w || worldY < y || worldY > y + h) {
			continue;
		}
		if (shapeContainsPoint(item.shape, worldX, worldY)) {
			return item;
		}
	}
	return null;
}
