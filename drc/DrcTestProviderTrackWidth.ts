/*
 * DRC_TEST_PROVIDER_TRACK_WIDTH — direct port of pcbnew/drc/
 * drc_test_provider_track_width.cpp (confirmed against the real source
 * at apps/kicad/pcbnew/drc/drc_test_provider_track_width.cpp, 165
 * lines). Checks every track/arc segment's width against
 * `TRACK_WIDTH_CONSTRAINT`'s resolved min/max — a small, direct check
 * needing none of the copper-clearance provider's spatial-index
 * machinery, just `DrcEngine.evalRules()` per item.
 *
 * Deliberately scoped down from the real provider:
 * - Arcs (`PCB_ARC_T`) aren't distinguished from straight segments —
 *   `PaintedItem`'s `'track'` kind covers both without a way to tell
 *   them apart here, but both carry a `width` on their painted segment
 *   shape, so the width check itself is identical either way (only the
 *   real function's `p0` violation-anchor point would differ: arc start
 *   vs. straight-segment midpoint — this port always uses the segment
 *   midpoint).
 * - `HasRulesForConstraintType()`'s early-out and error-limit checks
 *   aren't ported — this always runs the full check.
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 */
import type { LayeredBoardScene, PaintedItem } from '../paint/BoardPainter';
import type { DrcEngine } from '@kicad-model/src/pcb/drc/DrcEngine';
import { DrcConstraintType } from '@kicad-model/src/pcb/drc/DrcRule';
import { layerIdFromName } from '@kicad-model/src/pcb/layerNames';
import { Vec2 } from '../math/Vec2';

export interface TrackWidthViolation {
	/** Port of `DRCE_TRACK_WIDTH`. */
	item: PaintedItem;
	layer: string;
	/** Whether the actual width is below the min or above the max. */
	kind: 'min' | 'max';
	/** The violated bound, mm. */
	constraintWidth: number;
	/** The track's actual width, mm. */
	actual: number;
	location: Vec2;
}

/**
 * Port of `Run()`'s `checkTrackWidth` lambda — for every track (see file
 * header re: arcs), resolves `TRACK_WIDTH_CONSTRAINT` and flags it if the
 * painted segment's width falls outside the resolved min/max.
 */
export function testTrackWidths(scene: LayeredBoardScene, engine: DrcEngine): TrackWidthViolation[] {
	const violations: TrackWidthViolation[] = [];

	for (const items of scene.layerBuckets.values()) {
		for (const item of items) {
			if (item.kind !== 'track' || item.shape.type !== 'segment') continue;

			const actualMm = item.shape.width;
			const layer = layerIdFromName(item.layer);
			const constraint = engine.evalRules(DrcConstraintType.TRACK_WIDTH_CONSTRAINT, null, null, layer);

			const minIU = constraint.value.hasMin() ? constraint.value.min() : null;
			const maxIU = constraint.value.hasMax() ? constraint.value.max() : null;
			const actualIU = actualMm * 1e6; // pcbIuScale: 1mm = 1e6 IU

			const location = new Vec2((item.shape.x1 + item.shape.x2) / 2, (item.shape.y1 + item.shape.y2) / 2);

			if (minIU !== null && actualIU < minIU) {
				violations.push({ item, layer: item.layer, kind: 'min', constraintWidth: minIU / 1e6, actual: actualMm, location });
			}
			else if (maxIU !== null && actualIU > maxIU) {
				violations.push({ item, layer: item.layer, kind: 'max', constraintWidth: maxIU / 1e6, actual: actualMm, location });
			}
		}
	}

	return violations;
}
