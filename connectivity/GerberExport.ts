/*
 * Ported from KiCad source:
 *   common/plotters/GERBER_plotter.cpp
 *   include/plotters/gbr_plotter_apertures.h
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * A real RS-274X aperture-table-backed Gerber emitter — direct port of
 * `GERBER_PLOTTER`'s core: `StartPlot()`'s file header, `GetOrCreateAperture()`/
 * `selectAperture()`'s dedup-and-select logic, and `writeApertureList()`'s
 * `%ADDxx...*%` definitions (confirmed against the real source, a ~2000-
 * line file — this ports the standard-aperture subset only, see below).
 * This REPLACES an earlier version of this file that hardcoded a single
 * `G54D10*` aperture for every shape regardless of size — the header
 * comment claimed to be a port of the real files above but didn't
 * actually translate their logic; this is the fix for that.
 *
 * Deliberately scoped down from the real plotter, each noted at point of
 * use:
 * - Only the 4 STANDARD aperture types are ported: `AT_CIRCLE`, `AT_RECT`,
 *   `AT_OVAL`, `AT_PLOTTING` (round, for drawing lines). Every "aperture
 *   MACRO" type (round-rect, rotated-rect, chamfered-rect via 5-8-point
 *   outlines, rotated-oval, free-polygon — `writeApertureList()`'s entire
 *   `AM_*`/`APER_MACRO_*` switch arm) is NOT ported; a pad shape needing
 *   one of those falls back to a region fill (`Region()`) instead of a
 *   flash, same as this file's own previous fallback for `SHAPE_RECT`.
 * - Rotation is only honored at 0/90/180/270 degrees (an oval/rect simply
 *   swaps width/height at 90/270) — arbitrary rotation needs the
 *   `AM_ROT_RECT`/`AM_ROTATED_OVAL` macros above, not ported.
 * - X2 net/aperture attributes (`%TO...*%`/`%TD*%`, `formatNetAttribute()`,
 *   `GBR_APERTURE_METADATA`) aren't ported — no per-net/per-aperture
 *   metadata is attached, matching this file's previous scope.
 * - The real two-pass temp-file splice (`StartPlot()`/`EndPlot()`'s
 *   write-body-then-copy-with-apertures-spliced-in dance, needed in C++
 *   streaming I/O since apertures are only known after the body is
 *   plotted) isn't needed here — the whole output is an in-memory string,
 *   so `toString()` just assembles header + aperture defs + body + `M02*`
 *   directly, in the same order the real two-pass file ends up in.
 *
 * Coordinates in mm; the fixed-decimal Gerber coordinate format used
 * (`%FSLAX45Y45*%` — 4 integer digits, 5 decimal digits, matching this
 * file's own pre-existing 1e-5mm coordinate scale) predates this rewrite
 * and is unchanged.
 */

import { Vec2 } from '../math/Vec2';
import { SHAPE } from '../geometry/Shape';
import { SHAPE_CIRCLE } from '../geometry/ShapeCircle';
import { SHAPE_SEGMENT } from '../geometry/ShapeSegment';
import { SHAPE_RECT } from '../geometry/ShapeRect';
import { SHAPE_POLY_SET } from '../geometry/ShapePolySet';
import { SHAPE_LINE_CHAIN } from '../geometry/ShapeLineChain';

/** Port of `APERTURE::APERTURE_TYPE` (gbr_plotter_apertures.h) — standard-
 *  aperture subset only, see file header. */
export enum ApertureType {
	AT_CIRCLE = 1,
	AT_RECT = 2,
	AT_PLOTTING = 3,
	AT_OVAL = 4,
}

/** Port of `APERTURE` (gbr_plotter_apertures.h) — standard-aperture fields
 *  only (`m_Corners`/`m_Radius` macro-only fields aren't needed). */
interface Aperture {
	type: ApertureType;
	/** Width/height, mm. For AT_CIRCLE/AT_PLOTTING, `size.x` is the
	 *  diameter and `size.y` is unused (matches `GetDiameter()`). */
	size: { x: number; y: number };
	dCode: number;
}

function fmtSize(v: number): string {
	// Real KiCad's `{:#f}` (forced decimal point, default 6 places) —
	// aperture sizes are plain decimal mm/inch, not the fixed-integer
	// coordinate format.
	return v.toFixed(6);
}

/** A Gerber-export destination (line buffer). Real port of `GERBER_PLOTTER`'s
 *  core (see file header for exact scope). */
export class GERBER {
	private m_lines: string[] = [];
	private m_scale = 100000; // decimals: output at 1e-5 mm resolution
	private m_apertures: Aperture[] = [];
	private m_currentApertureIdx = -1;

	/** Emits a header line. */
	Comment(aText: string): void {
		this.m_lines.push(`G04 ${ aText }*`);
	}

	/** Port of `GetOrCreateAperture()` (the size/radius overload —
	 *  standard-aperture subset, see file header) + `selectAperture()`'s
	 *  dedup-and-emit-`Dxx*`-only-on-change logic. */
	private selectAperture(type: ApertureType, size: { x: number; y: number }): void {
		let idx = this.m_apertures.findIndex(a => a.type === type && a.size.x === size.x && a.size.y === size.y);
		if (idx < 0) {
			const dCode = 10 + this.m_apertures.length;
			this.m_apertures.push({ type, size: { ...size }, dCode });
			idx = this.m_apertures.length - 1;
		}
		if (idx !== this.m_currentApertureIdx) {
			this.m_currentApertureIdx = idx;
			this.m_lines.push(`D${ this.m_apertures[idx]!.dCode }*`);
		}
	}

	/** Emits a flash of a circle aperture (pad/via) at a point. Port of
	 *  `selectApertureWithAttributes()` + `emitDcode(pos, 3)` for the
	 *  `AT_CIRCLE` case. */
	FlashCircle(aCenter: Vec2, aDiameter: number): void {
		this.selectAperture(ApertureType.AT_CIRCLE, { x: aDiameter, y: aDiameter });
		this.m_lines.push(`X${ this.fmt(aCenter.x) }Y${ this.fmt(aCenter.y) }D03*`);
	}

	/** Flash a rectangular aperture (rect pad), axis-aligned or 90°-rotated
	 *  (see file header — other rotations aren't ported). */
	FlashRect(aCenter: Vec2, aWidth: number, aHeight: number, aRotationDeg = 0): void {
		const swapped = Math.abs(((aRotationDeg % 180) + 180) % 180 - 90) < 1;
		const size = swapped ? { x: aHeight, y: aWidth } : { x: aWidth, y: aHeight };
		this.selectAperture(ApertureType.AT_RECT, size);
		this.m_lines.push(`X${ this.fmt(aCenter.x) }Y${ this.fmt(aCenter.y) }D03*`);
	}

	/** Flash an oval (obround) aperture (oval/slot pad), axis-aligned or
	 *  90°-rotated (see file header). */
	FlashOval(aCenter: Vec2, aWidth: number, aHeight: number, aRotationDeg = 0): void {
		const swapped = Math.abs(((aRotationDeg % 180) + 180) % 180 - 90) < 1;
		const size = swapped ? { x: aHeight, y: aWidth } : { x: aWidth, y: aHeight };
		this.selectAperture(ApertureType.AT_OVAL, size);
		this.m_lines.push(`X${ this.fmt(aCenter.x) }Y${ this.fmt(aCenter.y) }D03*`);
	}

	/** Emits a draw (aperture travel) from A to B. Port of `ThickSegment()`'s
	 *  plain-segment case: select a round `AT_PLOTTING` aperture sized to
	 *  the line width (`SetCurrentLineWidth()`), then interpolate. */
	DrawSegment(aStart: Vec2, aEnd: Vec2, aWidth = 0): void {
		if (aWidth > 0) this.selectAperture(ApertureType.AT_PLOTTING, { x: aWidth, y: aWidth });
		this.m_lines.push(`G01*`);
		this.m_lines.push(`X${ this.fmt(aStart.x) }Y${ this.fmt(aStart.y) }D02*`);
		this.m_lines.push(`X${ this.fmt(aEnd.x) }Y${ this.fmt(aEnd.y) }D01*`);
	}

	/** Emits a polygon region (zone fill outline / a shape with no
	 *  standard-aperture equivalent — see file header). */
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

	/** Emits a shape using the appropriate command/aperture. */
	Shape(aShape: SHAPE): void {
		if (aShape instanceof SHAPE_CIRCLE) {
			this.FlashCircle(aShape.GetCenter(), aShape.GetRadius() * 2);
		} else if (aShape instanceof SHAPE_SEGMENT) {
			const width = 'GetWidth' in aShape && typeof (aShape as { GetWidth?: () => number }).GetWidth === 'function'
				? (aShape as unknown as { GetWidth(): number }).GetWidth()
				: 0;
			this.DrawSegment(aShape.GetPointA(), aShape.GetPointB(), width);
		} else if (aShape instanceof SHAPE_RECT) {
			// draw the rect as a region — a SHAPE_RECT alone carries no
			// rotation, so the standard AT_RECT flash aperture (which needs
			// a center point + width/height) can't be used faithfully here;
			// callers with a real pad center/size/rotation should call
			// FlashRect()/FlashOval() directly instead of going through
			// Shape().
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

	/** Port of `StartPlot()`'s format header + `EndPlot()`'s `M02*`
	 *  trailer, assembled around `writeApertureList()`'s `%ADDxx...*%`
	 *  definitions (standard-aperture subset — see file header) — real
	 *  KiCad splices these together via a two-pass temp file since
	 *  apertures are only known after plotting; this just orders three
	 *  in-memory string arrays the same way. */
	ToString(): string {
		const header: string[] = [];
		header.push(`%FSLAX45Y45*%`);
		header.push(`G04 Gerber Fmt 4.5, Leading zero omitted, Abs format (unit mm)*`);
		header.push(`%MOMM*%`);
		header.push(`%LPD*%`);
		header.push(`G01*`);
		header.push(`G04 APERTURE LIST*`);

		const apertureDefs = this.m_apertures.map(a => {
			switch (a.type) {
				case ApertureType.AT_CIRCLE:
				case ApertureType.AT_PLOTTING:
					return `%ADD${ a.dCode }C,${ fmtSize(a.size.x) }*%`;
				case ApertureType.AT_RECT:
					return `%ADD${ a.dCode }R,${ fmtSize(a.size.x) }X${ fmtSize(a.size.y) }*%`;
				case ApertureType.AT_OVAL:
					return `%ADD${ a.dCode }O,${ fmtSize(a.size.x) }X${ fmtSize(a.size.y) }*%`;
			}
		});

		return [...header, ...apertureDefs, `G04 APERTURE END LIST*`, ...this.m_lines, `M02*`].join('\n');
	}

	Lines(): string[] {
		return this.m_lines;
	}

	private fmt(v: number): string {
		return String(Math.round(v * this.m_scale));
	}
}
