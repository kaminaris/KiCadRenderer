import { Vec2 } from '../math/Vec2';

/*
	Ported from kicanvas's StrokePainter (src/viewers/base/painter.ts) — the
	dot/dash/gap length formulas and the segment-generation algorithm are
	KiCad's own (common/stroke_params.cpp: GetDotLength/GetGapLength/
	GetDashLength, line_correction=1.0, default dashed_line_gap_ratio=3,
	dashed_line_dash_ratio=12), not something invented here. Segments are
	generated as literal separate line pieces (not a native canvas dash
	pattern) because this renderer also has a WebGL backend with no
	equivalent primitive.

	kicanvas itself only wires this into POLYLINE strokes — its
	RectanglePainter/CirclePainter/ArcPainter always draw solid regardless of
	stroke type (a real gap on their end, confirmed by reading painter.ts).
	We apply the same algorithm to all four graphic shapes instead, since a
	rectangle/circle/arc outline is just a closed point ring once sampled,
	and a dashed grouping rectangle (the case that prompted this) is a
	common real annotation that shouldn't silently render solid.
*/

export type KicadStrokeLineType = 'default' | 'solid' | 'dash' | 'dot' | 'dash_dot' | 'dash_dot_dot' | string;

const lineCorrection = 1.0;
const defaultGapRatio = 3;
const defaultDashRatio = 12;

function dotLength(width: number): number {
	return Math.max(1.0 - lineCorrection, 0.2) * width;
}

function gapLength(width: number): number {
	return Math.max(defaultGapRatio + lineCorrection, 1.0) * width;
}

function dashLength(width: number): number {
	return Math.max(defaultDashRatio - lineCorrection, 1.0) * width;
}

/**
 * A stroke width of 0 means "use KiCad's rendered default" — an established
 * convention throughout this codebase (see buildWireLike's own comment),
 * NOT a literal zero-width line. But dotLength/gapLength/dashLength above
 * are all `ratio * width`, so a literal 0 here makes EVERY dash-pattern
 * entry 0 — and strokeDashedSegment's while loop only advances by
 * `min(pattern[i], remaining)` each iteration, so an all-zero pattern never
 * advances at all, spinning forever (found via a real file: a schematic-
 * level rectangle with `(stroke (width 0) (type dash))`, a common "dashed
 * grouping box" annotation with no explicit width — hung the whole tab on
 * load, not something that shows up in any small hand-built test fixture).
 * Substituting the same 0.15mm default buildWireLike already uses keeps
 * dash proportions sane for the default-width case; real KiCad does the
 * equivalent by resolving a real pen width before ever calling its own
 * (otherwise identical) GetDashLength/GetGapLength/GetDotLength formulas.
 */
function resolveDashWidth(width: number): number {
	return width > 0 ? width : 0.15;
}

/**
 * Walks an already-ordered point chain (NOT auto-closed — pass a ring with
 * the start point repeated at the end for a closed shape) and invokes
 * `drawSegment` once per solid piece: one call for the whole chain when
 * `lineType` is solid/default, one call per dash/dot/gap-separated piece
 * otherwise.
 */
export function strokeDashedPolyline(
	points: Vec2[], width: number, lineType: KicadStrokeLineType,
	drawSegment: (segment: Vec2[]) => void
): void {
	if (points.length < 2) {
		return;
	}
	if (lineType === 'solid' || lineType === 'default') {
		drawSegment(points);
		return;
	}
	for (let i = 0; i < points.length - 1; i++) {
		strokeDashedSegment(points[i]!, points[i + 1]!, width, lineType, drawSegment);
	}
}

function strokeDashedSegment(
	start: Vec2, end: Vec2, width: number, lineType: KicadStrokeLineType,
	drawSegment: (segment: Vec2[]) => void
): void {
	const lineVec = end.sub(start);
	const lineLen = lineVec.magnitude;
	if (lineLen === 0) {
		return;
	}
	const dirVec = lineVec.multiply(1 / lineLen);
	width = resolveDashWidth(width);

	let pattern: number[];
	switch (lineType) {
		case 'dash': pattern = [dashLength(width), gapLength(width)]; break;
		case 'dot': pattern = [dotLength(width), gapLength(width)]; break;
		case 'dash_dot': pattern = [dashLength(width), gapLength(width), dotLength(width), gapLength(width)]; break;
		case 'dash_dot_dot':
			pattern = [
				dashLength(width), gapLength(width),
				dotLength(width), gapLength(width),
				dotLength(width), gapLength(width),
			];
			break;
		default:
			drawSegment([start, end]);
			return;
	}

	let drawnLen = 0;
	let patternIndex = 0;
	while (drawnLen < lineLen) {
		let segLen = Math.min(pattern[patternIndex]!, lineLen - drawnLen);
		// Belt-and-suspenders on top of resolveDashWidth() above: a 0-length
		// pattern entry (any future formula change, a NaN width, ...) must
		// never stall this loop — force forward progress rather than trust
		// every possible pattern value to stay positive forever.
		if (segLen <= 0) {
			segLen = Math.min(lineLen * 0.01, lineLen - drawnLen);
		}
		// Even indices are the "on" pieces (dash/dot), odd indices are gaps.
		if (patternIndex % 2 === 0 && segLen > 0) {
			const segStart = start.add(dirVec.multiply(drawnLen));
			const segEnd = segStart.add(dirVec.multiply(segLen));
			drawSegment([segStart, segEnd]);
		}
		drawnLen += segLen;
		patternIndex = (patternIndex + 1) % pattern.length;
	}
}

/** Samples a circle into a closed point ring (start point repeated at the
 * end) so it can be run through the same dash algorithm as a polyline. */
export function circleToRing(center: Vec2, radius: number, segments = 64): Vec2[] {
	const pts: Vec2[] = [];
	for (let i = 0; i <= segments; i++) {
		const a = (i / segments) * Math.PI * 2;
		pts.push(new Vec2(center.x + radius * Math.cos(a), center.y + radius * Math.sin(a)));
	}
	return pts;
}

/** Samples an arc (start/end angle already resolved by the caller, in
 * radians, walked linearly so winding direction matches whatever the caller
 * computed) into an open point chain. */
export function arcToPolyline(center: Vec2, radius: number, startAngleRad: number, endAngleRad: number, segments = 32): Vec2[] {
	const pts: Vec2[] = [];
	const sweep = endAngleRad - startAngleRad;
	for (let i = 0; i <= segments; i++) {
		const a = startAngleRad + (sweep * i) / segments;
		pts.push(new Vec2(center.x + radius * Math.cos(a), center.y + radius * Math.sin(a)));
	}
	return pts;
}
