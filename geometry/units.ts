/*
 * Ported from KiCad source:
 *   include/units.h (units + coordinate conversion constants)
 *   common/units.cpp (EDA_UNITS helpers)
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * Unit / coordinate conversion constants KiCad code relies on. This port
 * works in mm (doubles) throughout, so the nm/mil conversions are provided
 * for parity with code that reasons in integer (nm) or iu nanometres.
 */

/** Nanometres per mm (the internal KiCad "iu" represent mm * 1e6). */
export const NM_PER_MM = 1_000_000;

/** mm per nanometre. */
export const MM_PER_NM = 1 / 1_000_000;

/** Nanometres per mil (1 mil = 1e-3 inch; 1 inch = 25.4 mm). */
export const NM_PER_MIL = (25.4 * NM_PER_MM) / 1000;

/** Mil per nanometre. */
export const MIL_PER_NM = 1 / NM_PER_MIL;

/** Inch per mm. */
export const MM_PER_INCH = 25.4;

/** mm to inches. */
export function mmToInches(aMm: number): number {
	return aMm / MM_PER_INCH;
}

/** inches to mm. */
export function inchesToMm(aIn: number): number {
	return aIn * MM_PER_INCH;
}

/** mm to mils (thousandths of an inch). */
export function mmToMils(aMm: number): number {
	return (aMm / MM_PER_INCH) * 1000;
}

/** mils to mm. */
export function milsToMm(aMils: number): number {
	return (aMils / 1000) * MM_PER_INCH;
}

/** mm to KiCad internal nanometre units. */
export function mmToNanos(aMm: number): number {
	return aMm * NM_PER_MM;
}

/** KiCad internal nanometre units to mm. */
export function nanosToMm(aNanos: number): number {
	return aNanos * MM_PER_NM;
}

/** Simple field-length / angle helper used by some serializers. */
export function degToRad(aDeg: number): number {
	return (aDeg * Math.PI) / 180;
}

export function radToDeg(aRad: number): number {
	return (aRad * 180) / Math.PI;
}

/** Normalizes an angle in degrees to [0, 360). */
export function normalizeAngleDeg(aDeg: number): number {
	const r = aDeg % 360;
	return r < 0 ? r + 360 : r;
}

/** The 45-degree-quantized version of an angle in degrees (0/45/90...315). */
export function quantizeTo45(aDeg: number): number {
	const n = normalizeAngleDeg(aDeg);
	const q = Math.round(n / 45) * 45;
	return q === 360 ? 0 : q;
}
