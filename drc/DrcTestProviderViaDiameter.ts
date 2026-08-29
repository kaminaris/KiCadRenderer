/*
 * DRC_TEST_PROVIDER_VIA_DIAMETER — direct port of pcbnew/drc/
 * drc_test_provider_via_diameter.cpp (confirmed against the real source
 * at apps/kicad/pcbnew/drc/drc_test_provider_via_diameter.cpp, 145
 * lines). Checks every via's diameter against `VIA_DIAMETER_CONSTRAINT`'s
 * resolved min/max, evaluated at `UNDEFINED_LAYER` — real KiCad's own
 * `// TODO: once we have padstacks this will need to run per-layer...`
 * comment, kept verbatim here since padstack-per-layer via sizing isn't
 * modeled in either codebase yet.
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 */
import type { LayeredBoardScene, PaintedItem } from '../paint/BoardPainter';
import type { DrcEngine } from '@kicad-model/src/pcb/drc/DrcEngine';
import { DrcConstraintType } from '@kicad-model/src/pcb/drc/DrcRule';
import { PcbLayerId } from '@kicad-model/src/core/types';
import { Vec2 } from '../math/Vec2';

export interface ViaDiameterViolation {
	/** Port of `DRCE_VIA_DIAMETER`. */
	item: PaintedItem;
	kind: 'min' | 'max';
	/** The violated bound, mm. */
	constraintDiameter: number;
	/** The via's actual diameter, mm. */
	actual: number;
	location: Vec2;
}

/** Port of `Run()`'s `checkViaDiameter` lambda. */
export function testViaDiameters(scene: LayeredBoardScene, engine: DrcEngine): ViaDiameterViolation[] {
	const violations: ViaDiameterViolation[] = [];

	for (const items of scene.layerBuckets.values()) {
		for (const item of items) {
			if (item.kind !== 'via' || item.shape.type !== 'circle') continue;

			const actualMm = item.shape.r * 2;
			const actualIU = actualMm * 1e6; // pcbIuScale: 1mm = 1e6 IU

			const constraint = engine.evalRules(DrcConstraintType.VIA_DIAMETER_CONSTRAINT, null, null, PcbLayerId.UNDEFINED);
			const minIU = constraint.value.hasMin() ? constraint.value.min() : null;
			const maxIU = constraint.value.hasMax() ? constraint.value.max() : null;
			const location = new Vec2(item.shape.cx, item.shape.cy);

			if (minIU !== null && actualIU < minIU) {
				violations.push({ item, kind: 'min', constraintDiameter: minIU / 1e6, actual: actualMm, location });
			}
			else if (maxIU !== null && actualIU > maxIU) {
				violations.push({ item, kind: 'max', constraintDiameter: maxIU / 1e6, actual: actualMm, location });
			}
		}
	}

	return violations;
}
