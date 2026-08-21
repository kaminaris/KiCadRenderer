/*
 * Ported from KiCad source:
 *   pcbnew/pcb_dimension.h (Aligned / Leader / Orthogonal / Center / Radial)
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * Board dimension geometry: the dimension type plus its measured span (text
 * position, start/end of the measured line). Mirrors PCB_DIMENSION.
 * Coordinates in mm.
 */

import { Vec2 } from '../math/Vec2';
import { BBox } from '../math/BBox';

/** Mirrors PCB_DIMENSION_BASE derived types. */
export enum DIMENSION_KIND {
	ALIGNED = 0,
	ORTHOGONAL = 1,
	LEADER = 2,
	CENTER = 3,
	RADIAL = 4,
}

/**
 * A board dimension. Mirrors the geometry of PCB_DIMENSION (the start/end
 * measured points and the text/shape position).
 */
export class PCB_DIMENSION {
	kind: DIMENSION_KIND = DIMENSION_KIND.ALIGNED;
	// The two measured points.
	start = new Vec2();
	end = new Vec2();
	// The position of the dimension text/value.
	textPos = new Vec2();
	layer = 0;
	height = 0.15;
	width = 0.15;

	constructor(aKind: DIMENSION_KIND = DIMENSION_KIND.ALIGNED) {
		this.kind = aKind;
	}

	GetStart(): Vec2 {
		return this.start.copy();
	}

	GetEnd(): Vec2 {
		return this.end.copy();
	}

	GetValue(): string {
		const len = this.start.sub(this.end).magnitude;
		// Format to 2 decimals, matching KiCad's default dimension precision.
		return `${ len.toFixed(2 ) }`;
	}

	/** Bounding box including the measured span and the text. */
	GetBoundingBox(): BBox {
		const pts = [this.start, this.end, this.textPos];
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const p of pts) {
			minX = Math.min(minX, p.x);
			minY = Math.min(minY, p.y);
			maxX = Math.max(maxX, p.x);
			maxY = Math.max(maxY, p.y);
		}
		// pad by line width
		return BBox.fromPoints([
			new Vec2(minX - this.width, minY - this.width),
			new Vec2(maxX + this.width, maxY + this.width),
		]);
	}
}
