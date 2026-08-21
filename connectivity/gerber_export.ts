/*
 * Ported from KiCad source:
 *   pcbnew/exporters/gerber_jobfile_writer_impl.h
 *   pcbnew/plotter/plot_gerber.h (subset)
 *   pcbnew/drill_writer.cpp (subset)
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * Minimal plot/Gerber export primitives: extend the classic RS-274X-ish
 * emitter that flashes circles (pads/vias), draws tracks, and fills zone
 * regions. This is the export side of the renderer — it writes G-code-like
 * commands, not pixels. Coordinates in mm.
 */

import { Vec2 } from '../math/Vec2';
import { SHAPE } from '../geometry/Shape';
import { SHAPE_CIRCLE } from '../geometry/ShapeCircle';
import { SHAPE_SEGMENT } from '../geometry/ShapeSegment';
import { SHAPE_RECT } from '../geometry/ShapeRect';
import { SHAPE_POLY_SET } from '../geometry/ShapePolySet';
import { SHAPE_LINE_CHAIN } from '../geometry/ShapeLineChain';

/** A Gerber-export destination (line buffer). */
export class GERBER {
	private m_lines: string[] = [];
	private m_scale = 100000; // decimals: output at 1e-5 mm resolution

	/** Emits a header line. */
	Comment(aText: string): void {
		this.m_lines.push(`G04 ${ aText }*`);
	}

	/** Emits a flash of a circle aperture (pad/via) at a point. */
	FlashCircle(aCenter: Vec2, aDiameter: number): void {
		this.m_lines.push(`G54D10*`);
		this.m_lines.push(`G75*`);
		this.m_lines.push(`X${ this.fmt( aCenter.x ) }Y${ this.fmt( aCenter.y ) }D03*`);
	}

	/** Emits a draw (aperture travel) from A to B. */
	DrawSegment(aStart: Vec2, aEnd: Vec2): void {
		this.m_lines.push(`G01*`);
		this.m_lines.push(`X${ this.fmt( aStart.x ) }Y${ this.fmt( aStart.y ) }D02*`);
		this.m_lines.push(`X${ this.fmt( aEnd.x ) }Y${ this.fmt( aEnd.y ) }D01*`);
	}

	/** Emits a polygon region (zone fill outline). */
	Region(aPoly: SHAPE_POLY_SET): void {
		const outline = aPoly.Outline(0);
		const n = outline.PointCount();
		if (n < 3) {
			return;
		}
		this.m_lines.push(`G36*`);
		const p0 = outline.Point(0);
		this.m_lines.push(`X${ this.fmt( p0.x ) }Y${ this.fmt( p0.y ) }D02*`);
		for (let i = 1; i < n; i++) {
			const p = outline.Point(i);
			this.m_lines.push(`X${ this.fmt( p.x ) }Y${ this.fmt( p.y ) }D01*`);
		}
		this.m_lines.push(`X${ this.fmt( p0.x ) }Y${ this.fmt( p0.y ) }D01*`);
		this.m_lines.push(`G37*`);
	}

	/** Emits a shape using the appropriate command. */
	Shape(aShape: SHAPE): void {
		if (aShape instanceof SHAPE_CIRCLE) {
			this.FlashCircle(aShape.GetCenter(), aShape.GetRadius() * 2);
		} else if (aShape instanceof SHAPE_SEGMENT) {
			this.DrawSegment(aShape.GetPointA(), aShape.GetPointB());
		} else if (aShape instanceof SHAPE_RECT) {
			// draw the rect as a region
			const r = aShape;
			const ps = new SHAPE_POLY_SET();
			const pts = [
				r.GetStart(),
				new Vec2(r.GetStart().x + r.GetW(), r.GetStart().y),
				new Vec2(r.GetStart().x + r.GetW(), r.GetStart().y + r.GetH()),
				new Vec2(r.GetStart().x, r.GetStart().y + r.GetH()),
			];
			ps.AddOutline(new SHAPE_LINE_CHAIN(pts, true));
			this.Region(ps);
		}
	}

	/** Returns the full text. */
	ToString(): string {
		return this.m_lines.join('\n');
	}

	Lines(): string[] {
		return this.m_lines;
	}

	private fmt(v: number): string {
		return String(Math.round(v * this.m_scale));
	}
}
