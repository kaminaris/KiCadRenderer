/*
 * Shared polygon/segment geometry predicates — the canonical implementations
 * used by the connectivity facades and the renderer's display hit-testing.
 *
 * These mirror the equivalent KiCad helper math (point-in-polygon ray-casting
 * and point-to-segment distance) so the ad-hoc duplicates that used to live in
 * the connectivity facades are consolidated here.
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later. Coordinates in mm.
 */

import { Vec2 } from '../math/Vec2';

/**
 * Ray-casting point-in-polygon test. `points` is a list of `{x,y}` vertices
 * (a closed or open ring); `tolerance` is accepted for API parity (the test
 * is exact on the ring interior, matches the historical behaviour of the
 * duplicated helpers it replaces).
 */
export function pointInPolygon(
	point: Vec2,
	points: { x: number; y: number }[],
	_tolerance: number
): boolean {
	let inside = false;
	for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
		const pi = points[i]!;
		const pj = points[j]!;
		const intersect =
			pi.y > point.y !== pj.y > point.y &&
			point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x;
		if (intersect) {
			inside = !inside;
		}
	}
	return inside;
}

/**
 * Distance from `point` to segment (x1,y1)-(x2,y2).
 */
export function pointToSegmentDistance(
	point: Vec2,
	x1: number,
	y1: number,
	x2: number,
	y2: number
): number {
	const dx = x2 - x1;
	const dy = y2 - y1;
	if (dx === 0 && dy === 0) {
		return point.sub(new Vec2(x1, y1)).magnitude;
	}
	const t = Math.max(
		0,
		Math.min(1, ((point.x - x1) * dx + (point.y - y1) * dy) / (dx * dx + dy * dy))
	);
	return point.sub(new Vec2(x1 + t * dx, y1 + t * dy)).magnitude;
}

/**
 * Distance from `point` to a polygon edge path (closed optionally).
 */
export function polygonEdgeDistance(
	points: { x: number; y: number }[],
	closed: boolean,
	point: Vec2
): number {
	let best = Infinity;
	const n = points.length;
	const count = closed ? n : Math.max(0, n - 1);
	for (let i = 0; i < count; i++) {
		const j = (i + 1) % n;
		const a = points[i]!;
		const b = points[j]!;
		best = Math.min(best, pointToSegmentDistance(point, a.x, a.y, b.x, b.y));
	}
	return best;
}

/**
 * Raw-coordinate convenience wrapper (legacy-PaintedShape-compatible):
 * distance from (px,py) to the polygon edge path.
 */
export function polygonEdgeDistanceCoords(
	points: { x: number; y: number }[],
	closed: boolean,
	px: number,
	py: number
): number {
	return polygonEdgeDistance(points, closed, new Vec2(px, py));
}

/**
 * Raw-coordinate convenience wrapper (legacy-PaintedShape-compatible):
 * distance from (px,py) to the segment (x1,y1)-(x2,y2).
 */
export function distanceToSegmentCoords(
	px: number,
	py: number,
	x1: number,
	y1: number,
	x2: number,
	y2: number
): number {
	return pointToSegmentDistance(new Vec2(px, py), x1, y1, x2, y2);
}

/**
 * Raw-coordinate convenience wrapper: point-in-polygon at (px,py).
 */
export function pointInPolygonCoords(
	points: { x: number; y: number }[],
	px: number,
	py: number
): boolean {
	return pointInPolygon(new Vec2(px, py), points, 0);
}
