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
		const segLen = Math.min(pattern[patternIndex]!, lineLen - drawnLen);
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
