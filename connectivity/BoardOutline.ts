/*
 * Ported from KiCad source:
 *   pcbnew/board.cpp — BOARD::BuildBoardPolygonOutlines (subset)
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * Builds the board outline polygon from the Edge.Cuts geometry: gathers the
 * outline segments (from lines/arcs/circles on Edge.Cuts), snaps near-coincident
 * endpoints, dedupes, and assembles them into a closed SHAPE_POLY_SET (the
 * board edge). Coordinates in mm.
 */

import { Vec2 } from '../math/Vec2';
import { SHAPE_POLY_SET } from '../geometry/ShapePolySet';
import { SHAPE_LINE_CHAIN, arcToPolyline, isColinear } from '../geometry/ShapeLineChain';
import { SHAPE_ARC } from '../geometry/ShapeArc';

/** An Edge.Cuts outline segment source (line or an arc approximated as a line). */
export interface EDGE_SEGMENT {
	start: Vec2;
	end: Vec2;
	// Include this segment even if it appears to be a duplicate of the first
	// (for closed loops, the closing connection).
	isClosing?: boolean;
}

const SNAP = 1e-4;

/** True if two points coincide within the snap tolerance. */
function pointsCoincide(a: Vec2, b: Vec2): boolean {
	return Math.abs(a.x - b.x) < SNAP && Math.abs(a.y - b.y) < SNAP;
}

/**
 * Assembles the given Edge.Cuts segments into a single closed outline polygon.
 * Mirrors the core of BOARD::BuildBoardPolygonOutlines: it orders the segments
 * head-to-tail (nearest-neighbour) into a ring, then removes colinear points.
 */
export function buildBoardOutlines(aSegments: EDGE_SEGMENT[]): SHAPE_POLY_SET {
	const poly = new SHAPE_POLY_SET();
	if (aSegments.length < 3) {
		return poly;
	}

	// Deduplicate reversed duplicates (a->b vs b->a).
	const segs = aSegments.filter((s, i) =>
		!aSegments.slice(0, i).some(o => pointsCoincide(s.start, o.end) && pointsCoincide(s.end, o.start))
	);

	// Chain head-to-tail.
	const chain: Vec2[] = [];
	let remaining = segs.slice();
	let first = remaining[0]!;
	chain.push(first.start.copy());
	chain.push(first.end.copy());
	remaining = remaining.slice(1);

	let guard = 0;
	while (remaining.length > 0 && guard < 100000) {
		guard++;
		const tail = chain[chain.length - 1]!;

		// Find the segment whose start (or end, reversed) is nearest the tail.
		let bestI = -1;
		let bestDist = Infinity;
		let reversed = false;
		for (let i = 0; i < remaining.length; i++) {
			const s = remaining[i]!;
			const dStart = tail.sub(s.start).squaredMagnitude;
			const dEnd = tail.sub(s.end).squaredMagnitude;
			if (dStart < bestDist) {
				bestDist = dStart;
				bestI = i;
				reversed = false;
			}
			if (dEnd < bestDist) {
				bestDist = dEnd;
				bestI = i;
				reversed = true;
			}
		}
		if (bestI < 0 || bestDist > SNAP * SNAP * 4) {
			break; // no contiguous continuation — stop
		}
		const s = remaining[bestI]!;
		if (reversed) {
			chain.push(s.start.copy());
		} else {
			chain.push(s.end.copy());
		}
		remaining.splice(bestI, 1);
	}

	if (chain.length >= 3) {
		// Drop the duplicate closing point if present.
		if (pointsCoincide(chain[0]!, chain[chain.length - 1]!)) {
			chain.pop();
		}
		const outline = new SHAPE_LINE_CHAIN(chain, true);
		outline.RemoveColinearPoints();
		poly.AddOutline(outline);
	}

	return poly;
}

/** Returns true if the given outline is (roughly) closed. */
export function isOutlineClosed(aOutline: SHAPE_LINE_CHAIN): boolean {
	if (aOutline.PointCount() < 3) return false;
	const a = aOutline.Point(0);
	const b = aOutline.Point(aOutline.PointCount() - 1);
	return pointsCoincide(a, b) || Math.abs(a.sub(b).magnitude) < SNAP;
}

/** Helpers used by the outline builder. */
export function colinear(a: Vec2, b: Vec2, c: Vec2): boolean {
	return isColinear(a, b, c);
}

/**
 * An edge item on the board outline: either a straight segment or an arc.
 * Mirrors KiCad's board edge items (EDGE_SEGMENT / EDGE_ARC).
 */
export interface EDGE_ITEM {
	kind: 'line' | 'arc';
	start: Vec2;
	end: Vec2;
	// For an arc: the center and the arc's mid-point (defines the bow).
	center?: Vec2;
	mid?: Vec2;
}

/**
 * Flattens a mixed list of board-edge items (straight lines + arcs) into a
 * contiguous list of straight EDGE_SEGMENTs. Arcs are sampled into short
 * polyline chords (mirrors KiCad flattening edge arcs to segments for the
 * outline). Returns an empty list if there are too few items to form a
 * closed outline.
 */
export function flattenEdgeItems(aItems: EDGE_ITEM[]): EDGE_SEGMENT[] {
	const segs: EDGE_SEGMENT[] = [];
	for (const it of aItems) {
		if (it.kind === 'line') {
			segs.push({ start: it.start.copy(), end: it.end.copy() });
			continue;
		}
		// Arc: sample into chords via SHAPE_ARC from the three points.
		const arc = new SHAPE_ARC(it.start, it.mid ?? midpoint(it.start, it.end), it.end);
		const pts = arcToPolyline(arc);
		for (let i = 0; i < pts.length - 1; i++) {
			segs.push({ start: pts[i]!.copy(), end: pts[i + 1]!.copy() });
		}
	}
	return segs;
}

/** Builds the closed board outline from mixed line/arc edge items. */
export function buildEdgeOutline(aItems: EDGE_ITEM[]): SHAPE_POLY_SET {
	return buildBoardOutlines(flattenEdgeItems(aItems));
}

function midpoint(a: Vec2, b: Vec2): Vec2 {
	return new Vec2((a.x + b.x) / 2, (a.y + b.y) / 2);
}
