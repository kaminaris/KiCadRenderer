/*
 * Ported from KiCad source:
 *   pcbnew/pcb_track.h (+ pcb_track.cpp)
 *   pcbnew/pcb_via.h
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * The canonical TRACK / PCB_VIA geometry: start/end, width, net, layer span,
 * and (for segments) the arc centre/radius. These are the classes behind the
 * connectivity `(segment ...)`/`(via ...)` AST elements. Coordinates in mm.
 */

import { Vec2 } from '../math/Vec2';
import { SHAPE } from '../geometry/Shape';
import { SHAPE_SEGMENT } from '../geometry/ShapeSegment';
import { SHAPE_CIRCLE } from '../geometry/ShapeCircle';
import { SHAPE_ARC } from '../geometry/ShapeArc';
import { SEG } from '../geometry/Seg';
import { PCB_LAYER_ID, LSET } from './ConnectivityItems';
import { VIATYPE } from './padstack';

/**
 * A PCB track (a straight or arced copper segment). Mirrors KiCad's PCB_TRACK.
 */
export class TRACK {
	start: Vec2 = new Vec2();
	end: Vec2 = new Vec2();
	width = 0.2;
	layer = PCB_LAYER_ID.F_Cu;
	net = 0;
	// For arcs: the center and mid point (KiCad: PCB_ARC stores center/start/
	// end and derives the rest).
	center: Vec2 | null = null;
	// Is this an arc track (PCB_ARC_T)?
	isArc = false;
	// The arc radius (for arc tracks).
	radius = 0;

	/** The start point. */
	GetStart(): Vec2 {
		return this.start.copy();
	}

	/** The end point. */
	GetEnd(): Vec2 {
		return this.end.copy();
	}

	/** The bounding box (centerline extents + width). */
	GetBoundingBox(): { x: number; y: number; x2: number; y2: number } {
		const half = this.width / 2;
		let minX = Math.min(this.start.x, this.end.x) - half;
		let minY = Math.min(this.start.y, this.end.y) - half;
		let maxX = Math.max(this.start.x, this.end.x) + half;
		let maxY = Math.max(this.start.y, this.end.y) + half;
		if (this.isArc && this.center) {
			const r = this.radius + half;
			minX = Math.min(minX, this.center.x - r);
			minY = Math.min(minY, this.center.y - r);
			maxX = Math.max(maxX, this.center.x + r);
			maxY = Math.max(maxY, this.center.y + r);
		}
		return { x: minX, y: minY, x2: maxX, y2: maxY };
	}

	/** The net code. */
	GetNetCode(): number {
		return this.net;
	}

	/** The track's copper layer. */
	GetLayer(): number {
		return this.layer;
	}

	/** The track as a SEG (centerline). */
	GetSeg(): SEG {
		return new SEG(this.start, this.end);
	}

	/** The track's effective copper shape (capsule, or arc). */
	Shape(): SHAPE {
		if (this.isArc && this.center) {
			// Approximate the arc with a segment from start to end (best-
			// effort; a faithful arc shape would Tessolate+Inflate).
			return new SHAPE_SEGMENT(this.start, this.end, this.width);
		}
		return new SHAPE_SEGMENT(this.start, this.end, this.width);
	}

	/** The arc shape for arc tracks (center/radius + start/end). */
	ArcShape(): SHAPE_ARC | null {
		if (!this.isArc || !this.center) {
			return null;
		}
		// KiCad arcs always go through the shorter way; without the mid point,
		// fall back to constructing from start/end via a synthetic mid (90 deg
		// through the center).
		const mid = this.getArcMidPoint();
		return new SHAPE_ARC(this.start, mid, this.end, this.width);
	}

	private getArcMidPoint(): Vec2 {
		// Bisect the angle from start to end around the center.
		const a1 = Math.atan2(this.start.y - this.center!.y, this.start.x - this.center!.x);
		const a2 = Math.atan2(this.end.y - this.center!.y, this.end.x - this.center!.x);
		let sweep = a2 - a1;
		while (sweep > Math.PI) sweep -= 2 * Math.PI;
		while (sweep <= -Math.PI) sweep += 2 * Math.PI;
		const midA = a1 + sweep / 2;
		const r = this.radius > 0 ? this.radius : this.start.sub(this.center!).magnitude;
		return new Vec2(this.center!.x + r * Math.cos(midA), this.center!.y + r * Math.sin(midA));
	}
}

/**
 * A via. Mirrors KiCad's PCB_VIA — a through/blind/micro via with a drill and
 * an annular pad. A via's copper is a circle (the annular ring) spanning its
 * connected layers.
 */
export class PCB_VIA {
	position: Vec2 = new Vec2();
	drill = 0.3;
	padDiameter = 0.6;
	viaType: VIATYPE = VIATYPE.THROUGH;
	net = 0;
	startLayer = PCB_LAYER_ID.F_Cu;
	endLayer = PCB_LAYER_ID.B_Cu;

	GetPosition(): Vec2 {
		return this.position.copy();
	}

	GetDrillSize(): number {
		return this.drill;
	}

	IsThrough(): boolean {
		return this.viaType === VIATYPE.THROUGH;
	}

	IsBlindBuried(): boolean {
		return this.viaType === VIATYPE.BLIND_BURIED;
	}

	IsMicroVia(): boolean {
		return this.viaType === VIATYPE.MICROVIA;
	}

	TopLayer(): number {
		return this.startLayer;
	}

	BottomLayer(): number {
		return this.endLayer;
	}

	/** The via's copper shape (annular pad as a disc). */
	Shape(): SHAPE {
		return new SHAPE_CIRCLE(this.position, this.padDiameter / 2);
	}

	/** The copper layers this via connects. */
	GetLayerSet(): LSET {
		const lset = new LSET();
		for (let l = this.startLayer; l <= this.endLayer && l < 32; l++) {
			lset.SetLayer(l);
		}
		if (this.viaType === VIATYPE.THROUGH) {
			lset.SetLayer(PCB_LAYER_ID.F_Cu);
			lset.SetLayer(PCB_LAYER_ID.B_Cu);
		}
		return lset;
	}

	GetBoundingBox(): { x: number; y: number; x2: number; y2: number } {
		const r = this.padDiameter / 2;
		return {
			x: this.position.x - r,
			y: this.position.y - r,
			x2: this.position.x + r,
			y2: this.position.y + r,
		};
	}
}
