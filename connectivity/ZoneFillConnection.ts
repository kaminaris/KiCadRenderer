/*
 * Ported from KiCad source:
 *   pcbnew/zone_filler.cpp (pad-to-zone connection resolution)
 *   pcbnew/pad.h + pcbnew/zone.h (thermal relief parameters)
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * Canonical pad-to-zone connection resolution, tying together the pad's
 * connection mode (PadClearances.effectiveZoneConnection), its thermal relief
 * spokes (ThermalRelief), and the solder mask/paste openings
 * (KicadBoardFacade.GetSolderMaskPolygon). This is the canonical API the
 * display-layer fill (BoardZoneFill) can opt into; the display fill is kept
 * as-is.
 */

import { SHAPE_POLY_SET } from '../geometry/ShapePolySet';
import { SHAPE } from '../geometry/Shape';
import { Vec2 } from '../math/Vec2';
import { ZONE_CONNECTION, PAD_CLEARANCES, effectiveZoneConnection, effectiveSpokeCount } from './PadClearances';
import { BuildThermalReliefSpokes, BuildThermalReliefRing } from './ThermalRelief';

/**
 * A resolved pad-to-zone connection: the mode, and (for THERMAL) the relief
 * geometry (spokes + knockout ring).
 */
export interface ZoneFillPadConnection {
	mode: ZONE_CONNECTION;
	// Thermal geometry (only when mode === THERMAL).
	spokes?: SHAPE_POLY_SET;
	// The annular knockout ring at pad radius + gap.
	reliefRing?: SHAPE_POLY_SET;
}

/**
 * Resolves a round pad's zone connection and builds its thermal relief.
 * Mirrors ZONE_FILLER / PAD::GetZoneConnection for the round-pad case.
 */
export function resolveRoundPadConnection(
	aCenter: Vec2,
	aRadius: number,
	aClearances: PAD_CLEARANCES,
	aIsThruHole: boolean
): ZoneFillPadConnection {
	const mode = effectiveZoneConnection(aClearances, aIsThruHole);

	if (mode !== ZONE_CONNECTION.THERMAL) {
		return { mode };
	}

	const spokeCount = effectiveSpokeCount(aClearances);
	const spokes = BuildThermalReliefSpokes(
		aCenter,
		aRadius,
		aClearances.thermalGap,
		aClearances.thermalWidth,
		spokeCount
	);
	const reliefRing = BuildThermalReliefRing(aCenter, aRadius, aClearances.thermalGap);

	return { mode, spokes, reliefRing };
}

/**
 * The canonical knockout polygon for a pad against a zone: the pad's copper
 * shape expanded by the zone clearance, except for THERMAL pads (which keep
 * the thermal gap ring + spokes). `aCopperShape` is the pad's effective shape.
 */
export function buildPadKnockout(
	aCopperShape: SHAPE,
	aClearances: PAD_CLEARANCES,
	aIsThruHole: boolean,
	aZoneClearance: number,
	aConvert: (shape: SHAPE, margin: number) => SHAPE_POLY_SET
): SHAPE_POLY_SET {
	const mode = effectiveZoneConnection(aClearances, aIsThruHole);

	if (mode === ZONE_CONNECTION.NONE) {
		// Knock out with the zone's own clearance.
		return aConvert(aCopperShape, aZoneClearance);
	}
	if (mode === ZONE_CONNECTION.FULL) {
		// Leave the pad solid (connected) — no knockout for same-net.
		return new SHAPE_POLY_SET();
	}
	// THERMAL — knocked out by the relief ring; the spokes bridge back.
	const bbox = aCopperShape.BBox();
	const center = bbox.center;
	const radius = Math.max(bbox.w, bbox.h) / 2;
	return BuildThermalReliefRing(center, radius, aClearances.thermalGap);
}
