/*
 * Ported from KiCad source:
 *   libs/kimath/include/... (TRANSFORM), common/text_attr.h, eeschema text geometry
 *   (pcbnew/pcb_text.h, common/text/cjk_textbox.cpp)
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * Text geometry: the attributes that govern how a piece of text lays out
 * (size, thickness, angle, mirror), plus bounding-box computation. Dimensions
 * in mm.
 */

import { Vec2 } from '../math/Vec2';
import { BBox } from '../math/BBox';

/** Mirrors TEXT_STYLE / TEXT_ATTRIBUTES's core fields. */
export class TEXT_ATTRIBUTES {
	// Text size (height, width) in mm.
	m_Size = new Vec2(1.27, 1.27);
	// Stroke thickness in mm.
	m_StrokeWidth = 0.15;
	// Rotation angle in degrees (0 = horizontal).
	m_AngleDeg = 0;
	// Mirrored horizontally.
	m_Mirrored = false;
	// Two-line multiline flag.
	m_Multiline = false;
	// Vertical justification.
	m_VertJustify = 0;
	// Horizontal justification (-1..1).
	m_HorzJustify = 0;

	GetSize(): Vec2 {
		return this.m_Size;
	}

	SetSize(aSize: Vec2): void {
		this.m_Size = aSize;
	}

	GetStrokeWidth(): number {
		return this.m_StrokeWidth;
	}

	SetStrokeWidth(aW: number): void {
		this.m_StrokeWidth = aW;
	}

	GetAngleDegrees(): number {
		return this.m_AngleDeg;
	}

	SetAngleDegrees(aDeg: number): void {
		this.m_AngleDeg = aDeg;
	}

	IsMirrored(): boolean {
		return this.m_Mirrored;
	}
}

/**
 * A piece of text with position + attributes, able to compute its bounding
 * box. Mirrors the geometry part of KiCad's EDA_TEXT (rotation, mirror,
 * multiline) for the renderer's label/field boxes.
 */
export class EDA_TEXT {
	position = new Vec2();
	attrs = new TEXT_ATTRIBUTES();
	text = '';

	constructor(aText = '', aPosition?: Vec2) {
		this.text = aText;
		if (aPosition) {
			this.position = aPosition;
		}
	}

	SetText(aText: string): void {
		this.text = aText;
	}

	GetText(): string {
		return this.text;
	}

	GetTextBox(): BBox {
		const w = this.attrs.m_Size.x;
		const h = this.attrs.m_Size.y;

		// Un-rotated box centered on position (KiCad anchors via justify),
		// grown by half the stroke width (the filled glyph extent).
		const stroke = this.attrs.m_StrokeWidth / 2;
		const cw = w * this.text.length * 0.5 + stroke;
		const ch = h * 0.5 + stroke;
		let corners = [
			new Vec2(-cw, -ch),
			new Vec2(cw, -ch),
			new Vec2(cw, ch),
			new Vec2(-cw, ch),
		];

		const ang = (this.attrs.m_AngleDeg * Math.PI) / 180;
		if (this.attrs.m_Mirrored) {
			corners = corners.map(c => new Vec2(-c.x, c.y));
		}
		const cos = Math.cos(ang);
		const sin = Math.sin(ang);
		corners = corners.map(c => new Vec2(c.x * cos - c.y * sin, c.x * sin + c.y * cos));

		const world = corners.map(c => new Vec2(this.position.x + c.x, this.position.y + c.y));
		return BBox.fromPoints(world);
	}

	/** True if the text is empty. */
	IsEmpty(): boolean {
		return this.text.length === 0;
	}
}

/**
 * Simple monospace text metrics for the stroke font: the advance (width) of a
 * run of text and its ascent, given the font height. Mirrors KIFONT metrics
 * loosely (KiCad uses a ~0.692 height:advance ratio).
 */
export interface TEXT_METRICS {
	width: number;
	height: number;
	lines: number;
}

/** Returns the width/height of a text measured at font height aFontHeightMm. */
export function measureText(aText: string, aFontHeightMm: number): TEXT_METRICS {
	const lines = aText.split('\n');
	const advance = aFontHeightMm * 0.692; // width of one 'M'-ish glyph
	let maxLen = 0;
	for (const l of lines) {
		maxLen = Math.max(maxLen, l.length);
	}
	return {
		width: maxLen * advance,
		height: aFontHeightMm * (lines.length || 1) * 1.4, // line height ~1.4x
		lines: lines.length || 1,
	};
}
