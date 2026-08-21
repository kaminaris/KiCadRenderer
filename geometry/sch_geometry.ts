/*
 * Ported from KiCad source:
 *   eeschema/sch_line.h
 *   eeschema/sch_bus_entry.h
 *   eeschema/sch_junction.h
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * Schematic geometry: wire/bus lines, bus entries (diagonal), and junctions.
 * These are simple 2-point / 4-point shapes. Coordinates in mm.
 */

import { Vec2 } from '../math/Vec2';
import { BBox } from '../math/BBox';
import { SEG } from './Seg';

/** Mirrors SCH_LINE_T: a wire, a bus, or a graphic line. */
export enum SCH_LINE_TYPE {
	WIRE = 0,
	BUS = 1,
	GRAPHIC = 2,
}

/**
 * A schematic wire/bus/graphic line. Mirrors KiCad's SCH_LINE /
 * SCH_BUS_WIRE_ENTRY.
 */
export class SCH_LINE {
	type: SCH_LINE_TYPE = SCH_LINE_TYPE.WIRE;
	start = new Vec2();
	end = new Vec2();
	wireWidth = 0.15;

	constructor(aStart?: Vec2, aEnd?: Vec2, aType: SCH_LINE_TYPE = SCH_LINE_TYPE.WIRE) {
		if (aStart) this.start = aStart;
		if (aEnd) this.end = aEnd;
		this.type = aType;
	}

	GetStartPoint(): Vec2 {
		return this.start.copy();
	}

	GetEndPoint(): Vec2 {
		return this.end.copy();
	}

	SetStartPoint(aP: Vec2): void {
		this.start = aP;
	}

	SetEndPoint(aP: Vec2): void {
		this.end = aP;
	}

	/** The line as a SEG (centerline, no width). */
	Seg(): SEG {
		return new SEG(this.start, this.end);
	}

	IsHorizontal(): boolean {
		return this.end.y === this.start.y;
	}

	IsVertical(): boolean {
		return this.end.x === this.start.x;
	}

	GetBoundingBox(): BBox {
		const half = this.wireWidth / 2;
		return BBox.fromPoints([
			new Vec2(Math.min(this.start.x, this.end.x) - half, Math.min(this.start.y, this.end.y) - half),
			new Vec2(Math.max(this.start.x, this.end.x) + half, Math.max(this.start.y, this.end.y) + half),
		]);
	}
}

/**
 * A bus entry — the 45° diagonal joining a wire to a bus. Mirrors KiCad's
 * SCH_BUS_WIRE_ENTRY (a line with a 45° orientation).
 */
export class SCH_BUS_ENTRY extends SCH_LINE {
	// Two angles: 45 or -45 degrees relative to horizontal.
	orientationDeg = 45;

	constructor(aCenter?: Vec2, aOrientationDeg = 45, aLength = 2.54) {
		super(undefined, undefined, SCH_LINE_TYPE.WIRE);
		this.orientationDeg = aOrientationDeg;
		if (aCenter) {
			this.setFromCenter(aCenter, aLength);
		}
	}

	setFromCenter(aCenter: Vec2, aLength: number): void {
		const dx = (aLength / 2) * Math.cos((this.orientationDeg * Math.PI) / 180);
		const dy = (aLength / 2) * Math.sin((this.orientationDeg * Math.PI) / 180);
		this.start = new Vec2(aCenter.x - dx, aCenter.y - dy);
		this.end = new Vec2(aCenter.x + dx, aCenter.y + dy);
	}

	GetCenter(): Vec2 {
		return this.start.add(this.end).multiply(0.5);
	}
}

/**
 * A connection junction (the dot where wires meet). Mirrors KiCad's
 * SCH_JUNCTION.
 */
export class SCH_JUNCTION {
	position = new Vec2();
	radius = 0.3;

	constructor(aPosition?: Vec2, aRadius = 0.3) {
		if (aPosition) {
			this.position = aPosition;
		}
		this.radius = aRadius;
	}

	GetPos(): Vec2 {
		return this.position.copy();
	}

	GetBoundingBox(): BBox {
		return new BBox(this.position.x - this.radius, this.position.y - this.radius, this.radius * 2, this.radius * 2);
	}
}

/**
 * A "no-connect" flag (an X at a pin). Mirrors KiCad's SCH_NO_CONNECT.
 */
export class SCH_NO_CONNECT {
	position = new Vec2();
	armLength = 0.635;

	constructor(aPosition?: Vec2, aArmLength = 0.635) {
		if (aPosition) {
			this.position = aPosition;
		}
		this.armLength = aArmLength;
	}

	GetPos(): Vec2 {
		return this.position.copy();
	}

	/** The X arms as data (4 points). */
	Arms(): Vec2[] {
		const a = this.armLength;
		return [
			new Vec2(this.position.x - a, this.position.y - a),
			new Vec2(this.position.x + a, this.position.y + a),
			new Vec2(this.position.x - a, this.position.y + a),
			new Vec2(this.position.x + a, this.position.y - a),
		];
	}
}
