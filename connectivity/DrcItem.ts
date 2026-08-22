/*
 * Ported from KiCad source:
 *   pcbnew/drc/drc_item.h (.cpp) — DRC_ITEM
 *   pcbnew/drc/drc_engine.cpp (concept) — collision testing
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * A DRC item (a found rule violation) and a simple collision runner that
 * checks a track/via/pad against obstacles using the canonical SHAPE model.
 * Coordinates in mm.
 */

import { Vec2 } from '../math/Vec2';
import { SHAPE } from '../geometry/Shape';
import { SHAPE_SEGMENT } from '../geometry/ShapeSegment';
import { SEG } from '../geometry/Seg';

/** Mirrors DRCE_* violation codes (subset). */
export enum DRCE {
	NO_VIOLATION = 0,
	COPPER_EDGE_CLEARANCE = 1,
	TRACK_WIDTH = 10,
	TRACK_VIA_HOLE_CLEARANCE = 40,
	PAD_VIA_HOLE_CLEARANCE = 41,
	COPPER_COPPER_FAR = 20,
}

/** Severity of a DRC item. */
export enum DRC_SEVERITY {
	INFO = 0,
	WARNING = 1,
	ERROR = 2,
}

/**
 * One DRC rule violation. Mirrors KiCad's DRC_ITEM.
 */
export class DRC_ITEM {
	kind: DRCE;
	severity: DRC_SEVERITY = DRC_SEVERITY.ERROR;
	// Position(s) of the violation (may be a segment/point).
	posA = new Vec2();
	posB = new Vec2();
	isPoint = true;
	description = '';
	/** The other item involved in the violation (obstacle owner id). */
	owner = '';

	constructor(aKind: DRCE, aDescription = '') {
		this.kind = aKind;
		this.description = aDescription;
	}

	/** A short message for this violation. */
	GetErrorMessage(): string {
		return this.description || `DRC violation code ${ this.kind }`;
	}

	/** Whether this is a real (error/warning) violation vs informational. */
	IsViolation(): boolean {
		return this.severity !== DRC_SEVERITY.INFO;
	}
}

/** An obstacle for DRC: a shape + net + clearance. */
export interface DRC_OBSTACLE {
	shape: SHAPE;
	net: number;
	owner: string;
}

/**
 * Runs a DRC clearance check of a centerline `aTestSeg` (width `aWidth`)
 * against a set of obstacles, ignoring the test item's own net. Returns the
 * first violation found (or null). Mirrors a simplified DRC track-vs-obstacle
 * clearance test using SHAPE_COLLISION.
 */
export function checkSegmentClearance(
	aTestSeg: SEG,
	aWidth: number,
	aNet: number,
	aObstacles: DRC_OBSTACLE[],
	aResolver: (netA: number, netB: number) => number
): DRC_ITEM | null {
	const testShape = new SHAPE_SEGMENT(aTestSeg.A, aTestSeg.B, aWidth);

	for (const obs of aObstacles) {
		if (obs.net === aNet) {
			continue; // same net: no clearance required
		}
		const clearance = aResolver(aNet, obs.net);
		try {
			if (testShape.Collide(obs.shape, clearance)) {
				const item = new DRC_ITEM(DRCE.COPPER_COPPER_FAR);
				item.posA = aTestSeg.A.copy();
				item.posB = aTestSeg.B.copy();
				item.owner = obs.owner;
				item.description = `Clearance violation vs ${ obs.owner } (${ obs.net })`;
				return item;
			}
		} catch {
			// shape pair not supported — skip
		}
	}
	return null;
}
