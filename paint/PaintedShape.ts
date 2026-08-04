// Precise geometry for hit-testing — the bbox on PaintedItem is only a
// broad-phase filter; for non-rectangular shapes the bbox over-selects (a
// diagonal track's AABB covers its whole diagonal span; a rotated pad's AABB
// is bigger than the pad itself).
export type PaintedShape =
	| { type: 'rect'; x: number; y: number; w: number; h: number; filled?: boolean; strokeWidth?: number }
	| { type: 'circle'; cx: number; cy: number; r: number; filled?: boolean; strokeWidth?: number }
	| { type: 'segment'; x1: number; y1: number; x2: number; y2: number; width: number }
	| { type: 'polygon'; points: { x: number; y: number }[]; filled?: boolean; closed?: boolean; strokeWidth?: number };

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

// Below this, a click anywhere inside an unfilled shape's interior is
// forgiving enough to still feel clickable without covering real ground —
// matches this codebase's existing 0.15mm wire/pin click-tolerance
// convention (buildWireLike etc.), used here as a floor under strokeWidth/2
// rather than a fixed value, so a deliberately thick outline still gets a
// proportionally thicker hit band.
const MIN_HIT_TOLERANCE = 0.15;

// `tolerance` is additive with strokeWidth/2, matching real KiCad's own
// EDA_SHAPE::hitTest formula exactly: `maxdist = aAccuracy; if (width > 0)
// maxdist += width/2` (common/eda_shape.cpp, confirmed in the user's local
// checkout) — aAccuracy there is a SCREEN-PIXEL threshold converted to world
// units by the caller (eeschema's HITTEST_THRESHOLD_PIXELS, 5px, converted
// via `view->ToWorld()`), which is what makes real KiCad's click target stay
// a constant, comfortable SIZE ON SCREEN at any zoom level — a fixed
// world-space tolerance is either too tight when zoomed out or needlessly
// loose when zoomed in. KicadRenderSession.hitTestAtScreen computes and
// passes that pixel-derived tolerance; MIN_HIT_TOLERANCE stays as a floor
// so a caller that omits tolerance (passes 0) keeps exactly the old
// behavior rather than regressing to "must click the exact zero-width line".
function edgeTolerance(strokeWidth: number | undefined, tolerance: number): number {
	return Math.max((strokeWidth ?? 0) / 2 + tolerance, MIN_HIT_TOLERANCE);
}

/** Distance from (x,y) to the nearest edge of a polyline/polygon — shared by
 * the unfilled edge-only test below and, promoted to exported (same reason
 * distanceToSegment was: avoid a second copy of this loop), by
 * SchematicPainter's rule-area-border dangling-forgiveness check. */
export function polygonEdgeDistance(points: { x: number; y: number }[], closed: boolean | undefined, x: number, y: number): number {
	let min = Infinity;
	for (let i = 0; i < points.length - 1; i++) {
		min = Math.min(min, distanceToSegment(x, y, points[i]!.x, points[i]!.y, points[i + 1]!.x, points[i + 1]!.y));
	}
	if (closed && points.length > 1) {
		const last = points[points.length - 1]!, first = points[0]!;
		min = Math.min(min, distanceToSegment(x, y, last.x, last.y, first.x, first.y));
	}
	return min;
}

/**
 * Precise point-in-shape test, used after the bbox broad-phase filter.
 *
 * `filled` defaults to true (unset === filled) so every EXISTING caller
 * that never set it (PCB pads/zones, filled symbol-body shapes, the
 * dangling-flag circles, …) keeps exactly its current whole-area hit-test
 * behavior — only callers that explicitly know their shape draws unfilled
 * opt into the edge-only test below.
 *
 * Ported from real KiCad's own EDA_SHAPE::hitTest (common/eda_shape.cpp,
 * confirmed in the user's local checkout): an UNFILLED closed shape
 * (rectangle/circle/poly with FILL_T::NO_FILL) hit-tests ONLY a thin band
 * around its own outline, not its whole enclosed area — otherwise any
 * schematic annotation box (a dashed "group these parts" rectangle, a rule
 * area, …) permanently steals clicks from everything visually inside it,
 * which is exactly the bug this fixes. `SCH_RULE_AREA` in real KiCad goes
 * further and overrides `IsFilledForHitTesting()` to ALWAYS return false
 * regardless of its own fill state — this app's buildRuleArea() does the
 * same by always passing `filled: false` rather than relying on rule areas
 * happening to always be unfilled in practice.
 *
 * `tolerance` (world units, default 0) is real KiCad's `aAccuracy` — see
 * edgeTolerance's comment. Filled shapes also get it (inflating the area
 * test outward), matching EDA_SHAPE::hitTest's own `arect.Inflate(aAccuracy)`
 * for box/area hit-tests — a filled shape is already an easy target, so this
 * mostly just keeps its OWN edge comfortably clickable too.
 */
export function shapeContainsPoint(shape: PaintedShape, x: number, y: number, tolerance = 0): boolean {
	switch (shape.type) {
		case 'rect': {
			if (shape.filled === false) {
				const tol = edgeTolerance(shape.strokeWidth, tolerance);
				const x2 = shape.x + shape.w, y2 = shape.y + shape.h;
				return distanceToSegment(x, y, shape.x, shape.y, x2, shape.y) <= tol
					|| distanceToSegment(x, y, x2, shape.y, x2, y2) <= tol
					|| distanceToSegment(x, y, x2, y2, shape.x, y2) <= tol
					|| distanceToSegment(x, y, shape.x, y2, shape.x, shape.y) <= tol;
			}
			return x >= shape.x - tolerance && x <= shape.x + shape.w + tolerance
				&& y >= shape.y - tolerance && y <= shape.y + shape.h + tolerance;
		}
		case 'circle': {
			const dx = x - shape.cx;
			const dy = y - shape.cy;
			if (shape.filled === false) {
				const tol = edgeTolerance(shape.strokeWidth, tolerance);
				return Math.abs(Math.hypot(dx, dy) - shape.r) <= tol;
			}
			const rTol = shape.r + tolerance;
			return dx * dx + dy * dy <= rTol * rTol;
		}
		case 'segment':
			return distanceToSegment(x, y, shape.x1, shape.y1, shape.x2, shape.y2) <= shape.width / 2 + tolerance;
		case 'polygon': {
			if (shape.filled === false) {
				const tol = edgeTolerance(shape.strokeWidth, tolerance);
				return polygonEdgeDistance(shape.points, shape.closed, x, y) <= tol;
			}
			if (pointInPolygon(shape.points, x, y)) {
				return true;
			}
			return tolerance > 0 && polygonEdgeDistance(shape.points, shape.closed, x, y) <= tolerance;
		}
	}
}

export function distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
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
