/*
 * Ported from KiCad source:
 *   pcbnew/pad.h
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * PAD clearance / connection settings that influence zone fill and DRC:
 * solder mask margin, solder paste margin, zone connection mode, and thermal
 * relief (gap + spoke width). Dimensions in mm.
 */

/** Mirrors pcbnew/zone.h ZONE_CONNECTION. */
export enum ZONE_CONNECTION {
	THERMAL = 0,
	FULL = 1,
	NONE = 2,
	THT_THERMAL = 3,
}

/**
 * The clearance / connection parameters of a pad. Mirrors the relevant
 * accessors of KiCad's PAD (pcbnew/pad.h).
 */
export class PAD_CLEARANCES {
	// Solder mask expansion (positive expands the mask opening beyond the pad).
	solderMaskMargin = 0; // auto (often ~0.075 for legacy)
	// Solder paste expansion (relative; positive shrinks, negative enlarges the
	// stencil opening — KiCad stores these inverted-ish via SetSolderPasteMargin).
	solderPasteMargin = 0;
	solderPasteMarginRatio = -0.25;
	// Zone connection mode for this pad.
	zoneConnection: ZONE_CONNECTION = ZONE_CONNECTION.FULL;
	// Thermal relief gap and spoke width (mm).
	thermalGap = 0.25;
	thermalWidth = 0.25;
	// Custom spoke count (0 = default 4).
	customSpokeCount = 0;

	constructor(opts?: Partial<PAD_CLEARANCES>) {
		if (opts) {
			Object.assign(this, opts);
		}
	}

	GetSolderMaskMargin(): number {
		// Default mask margin when 0 is 0 for SMD pads with fillet? KiCad keeps
		// m_solderMaskMargin; 0 means the pad metal (no expansion). Keep as-is.
		return this.solderMaskMargin;
	}

	GetSolderPasteMargin(): number {
		return this.solderPasteMargin;
	}

	GetSolderPasteMarginRatio(): number {
		return this.solderPasteMarginRatio;
	}

	GetZoneConnection(): ZONE_CONNECTION {
		return this.zoneConnection;
	}

	SetZoneConnection(aMode: ZONE_CONNECTION): void {
		this.zoneConnection = aMode;
	}

	GetThermalGap(): number {
		return this.thermalGap;
	}

	GetThermalWidth(): number {
		return this.thermalWidth;
	}

	GetCustomSpokeCount(): number {
		return this.customSpokeCount;
	}

	/** Effective spoke count (0 => 4). */
	GetSpokeCount(): number {
		return this.customSpokeCount > 0 ? this.customSpokeCount : 4;
	}
}
