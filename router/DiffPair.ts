/*
 * Ported from KiCad source:
 *   pcbnew/router/pns_diff_pair.cpp — dimension helpers
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * Differential-pair routing dimensions: the coupled width/gap used to place
 * the P and N lines, and the coupling angle at corners. Dimensions in mm.
 */

import { NETCLASS } from '../connectivity/netinfo';

/**
 * The diff-pair dimensions resolved from a NETCLASS (gap, width). Mirrors the
 * relevant fields of KiCad's DIFF_PAIR / NETCLASS.
 */
export interface DiffPairDims {
	width: number;
	gap: number;
	viaGap: number;
}

/**
 * Returns the diff-pair dimensions for the given NETCLASS. Mirrors KiCad's
 * netclass diff-pair settings.
 */
export function diffPairDimsFromNetclass(aNetClass: NETCLASS): DiffPairDims {
	return {
		width: aNetClass.diffPairWidth,
		gap: aNetClass.diffPairGap,
		viaGap: aNetClass.diffPairViaGap,
	};
}

/**
 * The coupled line width (the P/N trace width for a diff pair).
 */
export function DPPrimaryWidth(aDims: DiffPairDims): number {
	return aDims.width;
}

/**
 * The primary gap between the two coupled lines (edge to edge).
 */
export function DPPrimaryGap(aDims: DiffPairDims): number {
	return aDims.gap;
}

/**
 * The offset of one line from the pair's centreline, given the gap and width.
 * Each line centre is (gap + width)/2 from the pair centreline. Mirrors
 * KiCad's DIFF_PAIR::DPOffset.
 */
export function DPCoupledLineOffset(aDims: DiffPairDims): number {
	return (aDims.gap + aDims.width) / 2;
}

/**
 * The angle (in degrees) a diff pair turns at via a corner, used to keep the
 * two lines coupled. Mirrors KiCad's DP_CoupledEnd / corner handling
 * (best-effort; returns the angle between the two segments).
 */
export function DPCornerAngle(aIncoming: number, aOutgoing: number): number {
	let d = aOutgoing - aIncoming;
	while (d > 180) d -= 360;
	while (d < -180) d += 360;
	return Math.abs(d);
}
