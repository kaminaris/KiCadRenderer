/*
 * DRC_TEST_PROVIDER_HOLE_SIZE — scoped port of pcbnew/drc/
 * drc_test_provider_hole_size.cpp's `checkPadHole()` + `checkViaHole()`
 * (confirmed against the real source at apps/kicad/pcbnew/drc/
 * drc_test_provider_hole_size.cpp, 263 lines — `Run()`'s own
 * footprint/track iteration is replaced by a scan over
 * `LayeredBoardScene`'s painted pad/via items, using the `drillSize`
 * field added to `PaintedItem` specifically for this check). Evaluated at
 * `UNDEFINED_LAYER`, matching real KiCad — holes aren't layer-specific.
 *
 * Deliberately scoped down from the real provider:
 * - Micro-via vs. standard-via distinction (`DRCE_MICROVIA_DRILL_OUT_OF_RANGE`
 *   vs. `DRCE_DRILL_OUT_OF_RANGE`) isn't ported — `PaintedItem` doesn't
 *   distinguish via type, so every via is checked against the single
 *   `HOLE_SIZE_CONSTRAINT` (which itself only has one implicit rule
 *   today — see `DrcEngine.ts`'s `loadImplicitRules()` — the micro-via-
 *   specific conditional rule from real KiCad's own `loadImplicitRules()`
 *   isn't ported either, consistently).
 * - `DRCE_PADSTACK` (padstack-specific hole/pad-shape mismatch errors)
 *   isn't ported — no padstack subsystem exists in this port yet.
 * - The violation anchor geometry (`ptA`/`ptB`, a line from the item's
 *   center partway into the hole) is simplified to the item's own
 *   position only.
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 */
import type { LayeredBoardScene, PaintedItem } from '../paint/BoardPainter';
import type { DrcEngine } from '@kicad-model/src/pcb/drc/DrcEngine';
import { DrcConstraintType } from '@kicad-model/src/pcb/drc/DrcRule';
import { PcbLayerId } from '@kicad-model/src/core/types';
import { Vec2 } from '../math/Vec2';

export interface HoleSizeViolation {
	/** Port of `DRCE_DRILL_OUT_OF_RANGE`. */
	item: PaintedItem;
	kind: 'min' | 'max';
	/** The violated bound, mm. */
	constraintValue: number;
	/** The hole's actual minor/major dimension (whichever failed), mm. */
	actual: number;
	location: Vec2;
}

function itemCenter(item: PaintedItem): Vec2 {
	const s = item.shape;
	if (s.type === 'circle') return new Vec2(s.cx, s.cy);
	if (s.type === 'rect') return new Vec2(s.x + s.w / 2, s.y + s.h / 2);
	return new Vec2(item.bbox.x + item.bbox.w / 2, item.bbox.y + item.bbox.h / 2);
}

/**
 * Port of `checkPadHole()` + `checkViaHole()`, unified into one pass over
 * every painted pad/via with a real drill (see file header for scope).
 */
export function testHoleSizes(scene: LayeredBoardScene, engine: DrcEngine): HoleSizeViolation[] {
	const violations: HoleSizeViolation[] = [];
	const seen = new Set<string>();

	for (const items of scene.layerBuckets.values()) {
		for (const item of items) {
			if ((item.kind !== 'pad' && item.kind !== 'via') || !item.drillSize) continue;
			// A through-hole pad is painted once per copper layer bucket —
			// dedup by id prefix (real KiCad checks the hole once per item,
			// not once per layer, since holes aren't layer-specific).
			const key = item.id.split(':').slice(0, -1).join(':') || item.id;
			if (seen.has(key)) continue;
			seen.add(key);

			const holeMinorMm = Math.min(item.drillSize.width, item.drillSize.height);
			const holeMajorMm = Math.max(item.drillSize.width, item.drillSize.height);
			if (holeMinorMm === 0) continue;

			const constraint = engine.evalRules(DrcConstraintType.HOLE_SIZE_CONSTRAINT, null, null, PcbLayerId.UNDEFINED);
			const minIU = constraint.value.hasMin() ? constraint.value.min() : null;
			const maxIU = constraint.value.hasMax() ? constraint.value.max() : null;
			const location = itemCenter(item);

			if (maxIU !== null && holeMajorMm * 1e6 > maxIU) {
				violations.push({ item, kind: 'max', constraintValue: maxIU / 1e6, actual: holeMajorMm, location });
			}
			if (minIU !== null && holeMinorMm * 1e6 < minIU) {
				violations.push({ item, kind: 'min', constraintValue: minIU / 1e6, actual: holeMinorMm, location });
			}
		}
	}

	return violations;
}
