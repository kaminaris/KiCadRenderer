/*
 * Ported from KiCad source:
 *   pcbnew/footprint.h (.cpp)
 *   pcbnew/pad.h (subset)
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * The canonical FOOTPRINT model: pads, reference/value text fields, position
 * and orientation (angle + mirror), and pad lookup. Complements the AST
 * facade (which adapts footprints for connectivity) with a plain class.
 * Coordinates in mm.
 */

import { Vec2 } from '../math/Vec2';
import { SHAPE } from '../geometry/Shape';
import { TRANSFORM } from '../geometry/Transform';
import { PCB_LAYER_ID } from './ConnectivityItems';

/** One pad of a footprint. */
export class FP_PAD {
	number = '';
	net = 0;
	position = new Vec2();
	// Shape/size (delegating to the padstack geometry pattern).
	shape: 'circle' | 'oval' | 'rect' | 'roundrect' | 'custom' = 'rect';
	size = new Vec2(1.5, 1.5);
	drill = 0; // 0 = no hole (SMD)
	layer = PCB_LAYER_ID.F_Cu;
	// Whether it is a through-hole pad.
	hasHole = false;

	GetNumber(): string {
		return this.number;
	}

	GetPosition(): Vec2 {
		return this.position.copy();
	}

	SetPosition(aPos: Vec2): void {
		this.position = aPos;
	}

	GetNetCode(): number {
		return this.net;
	}

	SetNetCode(aNet: number): void {
		this.net = aNet;
	}

	GetLayer(): number {
		return this.layer;
	}

	IsThroughHole(): boolean {
		return this.hasHole;
	}

	/** The pad's copper shape (a rect/oval/circle approximation). */
	Shape(_layer?: number): SHAPE {
		return padShapeToShape(this.shape, this.position, this.size, 0);
	}

	/** The pad's connection anchor point(s) — where wires attach. */
	GetConnectionPoints(): Vec2[] {
		return [this.position.copy()];
	}
}

/* eslint-disable-next-line @typescript-eslint/explicit-function-return-type */
import { SHAPE_CIRCLE } from '../geometry/ShapeCircle';
import { SHAPE_RECT } from '../geometry/ShapeRect';
import { SHAPE_SEGMENT } from '../geometry/ShapeSegment';

function padShapeToShape(
	shape: string,
	position: Vec2,
	size: Vec2,
	_cornerRadius = 0
): SHAPE {
	switch (shape) {
		case 'circle':
			return new SHAPE_CIRCLE(position, size.x / 2);
		case 'oval':
			if (size.x > size.y) {
				return new SHAPE_SEGMENT(
					new Vec2(position.x - (size.x - size.y) / 2, position.y),
					new Vec2(position.x + (size.x - size.y) / 2, position.y),
					size.y
				);
			}
			return new SHAPE_SEGMENT(
				new Vec2(position.x, position.y - (size.y - size.x) / 2),
				new Vec2(position.x, position.y + (size.y - size.x) / 2),
				size.x
			);
		case 'rect':
		case 'roundrect':
		case 'custom':
		default:
			return new SHAPE_RECT(
				new Vec2(position.x - size.x / 2, position.y - size.y / 2),
				size
			);
	}
}

/**
 * The canonical FOOTPRINT. Mirrors KiCad's FOOTPRINT: a list of pads, the
 * Reference/Value fields, position/orientation, and the transform (mirror +
 * rotation) applied when placing on the board.
 */
export class FOOTPRINT {
	reference = '';
	value = '';
	position = new Vec2();
	// Rotation in degrees.
	orientation = 0;
	// Mirrored (flipped to the back layer).
	mirrored = false;
	layer: 'F.Cu' | 'B.Cu' = 'F.Cu';
	pads: FP_PAD[] = [];
	datasheet = '';

	GetPosition(): Vec2 {
		return this.position.copy();
	}

	SetPosition(aPos: Vec2): void {
		this.position = aPos;
	}

	GetOrientationDegrees(): number {
		return this.orientation;
	}

	SetOrientationDegrees(aDeg: number): void {
		this.orientation = aDeg;
	}

	IsFlipped(): boolean {
		return this.mirrored;
	}

	/** Flips the footprint to the opposite board side (mirrored), keeping its
	 *  pad local positions (which mirror through the footprint transform). */
	Flip(toBack = true): void {
		this.mirrored = toBack;
		this.layer = this.mirrored ? 'B.Cu' : 'F.Cu';
	}

	GetReference(): string {
		return this.reference;
	}

	GetValue(): string {
		return this.value;
	}

	GetPadCount(): number {
		return this.pads.length;
	}

	/** Find a pad by its number (e.g. "1", "A2"). */
	FindPadByNumber(aNumber: string): FP_PAD | null {
		return this.pads.find(p => p.number === aNumber) ?? null;
	}

	Pads(): FP_PAD[] {
		return this.pads;
	}

	/** True if this footprint is a net-tie (has duplicated pad numbers, which
	 *  KiCad treats as electrically-joined pads). Mirrors
	 *  PAD::GetDuplicatePadNumbersAreJumpers / net-tie detection. */
	IsNetTie(): boolean {
		if (this.duplicatePadNumbersAreJumpers) {
			return true;
		}
		const seen = new Set<string>();
		for (const p of this.pads) {
			if (seen.has(p.number)) {
				return true;
			}
			seen.add(p.number);
		}
		return false;
	}

	duplicatePadNumbersAreJumpers = false;

	/** Connection points for all pads (ordered by pad number). */
	GetConnectionPoints(): Vec2[] {
		// Order pads by their number (string-numeric) for stable anchors.
		const sorted = [...this.pads].sort((a, b) =>
			(+a.number || 0) - (+b.number || 0) || a.number.localeCompare(b.number)
		);
		return sorted.map(p => p.position.copy());
	}

	/** The footprint's graphics (fp_line/rect/circle/arc/poly/bezier) — the
	 *  fp-editor shape primitives this footprint body is drawn from. */
	graphics: import('../geometry/FpPrimitives').FP_SHAPE[] = [];

	/** Returns the fp-editor graphics primitives. */
	GetGraphics(): import('../geometry/FpPrimitives').FP_SHAPE[] {
		return this.graphics;
	}

	/** The transform that maps footprint-local coords to board coords. */
	GetTransform(): TRANSFORM {
		const rad = (this.orientation * Math.PI) / 180;
		let t = new TRANSFORM(Math.cos(rad), -Math.sin(rad), Math.sin(rad), Math.cos(rad));
		if (this.mirrored) {
			t = new TRANSFORM(-1, 0, 0, 1).Multiply(t);
		}
		return t;
	}

	/** Transforms a footprint-local point into board space. */
	TransformPoint(aLocal: Vec2): Vec2 {
		return this.GetTransform().TransformCoordinate(aLocal).add(this.position);
	}

	/** The footprint's pad field text (Reference) for netlist matching. */
	GetFieldText(aField: 'Reference' | 'Value' | 'Datasheet'): string {
		switch (aField) {
			case 'Reference':
				return this.reference;
			case 'Value':
				return this.value;
			case 'Datasheet':
				return this.datasheet;
		}
	}
}
