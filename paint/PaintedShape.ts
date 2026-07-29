// Precise geometry for hit-testing — the bbox on PaintedItem is only a
// broad-phase filter; for non-rectangular shapes the bbox over-selects (a
// diagonal track's AABB covers its whole diagonal span; a rotated pad's AABB
// is bigger than the pad itself).
export type PaintedShape =
	| { type: 'rect'; x: number; y: number; w: number; h: number }
	| { type: 'circle'; cx: number; cy: number; r: number }
	| { type: 'segment'; x1: number; y1: number; x2: number; y2: number; width: number }
	| { type: 'polygon'; points: { x: number; y: number }[] };

export function shapeToBBox(shape: PaintedShape): { x: number; y: number; w: number; h: number } {
	switch (shape.type) {
		case 'rect':
			return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
		case 'circle':
			return { x: shape.cx - shape.r, y: shape.cy - shape.r, w: shape.r * 2, h: shape.r * 2 };
		case 'segment': {
			const half = shape.width / 2;
			return {
				x: Math.min(shape.x1, shape.x2) - half,
				y: Math.min(shape.y1, shape.y2) - half,
				w: Math.abs(shape.x2 - shape.x1) + shape.width,
				h: Math.abs(shape.y2 - shape.y1) + shape.width,
			};
		}
		case 'polygon': {
			let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
			for (const p of shape.points) {
				minX = Math.min(minX, p.x);
				minY = Math.min(minY, p.y);
				maxX = Math.max(maxX, p.x);
				maxY = Math.max(maxY, p.y);
			}
			return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
		}
	}
}

/** Precise point-in-shape test, used after the bbox broad-phase filter. */
export function shapeContainsPoint(shape: PaintedShape, x: number, y: number): boolean {
	switch (shape.type) {
		case 'rect':
			return x >= shape.x && x <= shape.x + shape.w && y >= shape.y && y <= shape.y + shape.h;
		case 'circle': {
			const dx = x - shape.cx;
			const dy = y - shape.cy;
			return dx * dx + dy * dy <= shape.r * shape.r;
		}
		case 'segment':
			return distanceToSegment(x, y, shape.x1, shape.y1, shape.x2, shape.y2) <= shape.width / 2;
		case 'polygon':
			return pointInPolygon(shape.points, x, y);
	}
}

function distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
	const dx = x2 - x1;
	const dy = y2 - y1;
	const lengthSq = dx * dx + dy * dy;
	if (lengthSq === 0) {
		return Math.hypot(px - x1, py - y1);
	}
	let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
	t = Math.max(0, Math.min(1, t));
	const closestX = x1 + t * dx;
	const closestY = y1 + t * dy;
	return Math.hypot(px - closestX, py - closestY);
}

// Standard ray-casting point-in-polygon test.
function pointInPolygon(points: { x: number; y: number }[], px: number, py: number): boolean {
	let inside = false;
	for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
		const xi = points[i]!.x, yi = points[i]!.y;
		const xj = points[j]!.x, yj = points[j]!.y;
		const intersects = (yi > py) !== (yj > py) &&
			px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
		if (intersects) {
			inside = !inside;
		}
	}
	return inside;
}
